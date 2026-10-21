
'use strict';

require('dotenv').config();

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');

// =====================================================
// CONFIGURAÇÕES
// =====================================================

const TCP_PORT = Number(process.env.TCP_PORT || 3003);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3001);
const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';

const API_KEY = process.env.API_KEY || '';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK || '';

const HEARTBEAT_ACC_BIT =
  process.env.HEARTBEAT_ACC_BIT !== 'false';

const ENABLE_EXPERIMENTAL_RELAY =
  process.env.ENABLE_EXPERIMENTAL_RELAY === 'true';

const RELAY_ON_CMD = 'RELAY,1#';
const RELAY_OFF_CMD = 'RELAY,0#';

const SERVER_FLAG_HEX =
  process.env.SERVER_FLAG || '00000000';

if (!/^[0-9a-fA-F]{8}$/.test(SERVER_FLAG_HEX)) {
  throw new Error('SERVER_FLAG deve conter 8 caracteres HEX');
}

const SERVER_FLAG = Buffer.from(SERVER_FLAG_HEX, 'hex');

const sessions = new Map();
const devices = new Map();
const responses = [];

const MAX_RESPONSES = 200;
let serial = 1;
let lastLocation = null;

// =====================================================
// UTILITÁRIOS
// =====================================================

function iso() {
  return new Date().toISOString();
}

function log(event) {
  fs.appendFile(
    'tp7-events.jsonl',
    JSON.stringify(event) + '\n',
    err => {
      if (err) console.error('[LOG ERROR]', err.message);
    }
  );
}

function hexByte(value) {
  return '0x' + value.toString(16).padStart(2, '0');
}

function nextSerial() {
  const current = serial++;
  if (serial > 65535) serial = 1;
  return current;
}

// =====================================================
// CRC16 X25 / GT06
// =====================================================

function crc16X25(bytes) {
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte;

    for (let i = 0; i < 8; i++) {
      crc = (crc & 1)
        ? ((crc >>> 1) ^ 0x8408)
        : (crc >>> 1);
    }
  }

  return (~crc) & 0xffff;
}

// =====================================================
// MONTAGEM DE PACOTES GT06
// =====================================================

function frame(protocol, content, sequence, long = false) {
  const body = Buffer.concat([
    Buffer.from([protocol]),
    content,
    Buffer.from([
      (sequence >>> 8) & 255,
      sequence & 255
    ])
  ]);

  const length = body.length + 2;

  if (!long && length > 255) {
    throw new Error('Pacote curto GT06 excede 255 bytes');
  }

  if (length > 65535) {
    throw new Error('Pacote GT06 excede 65535 bytes');
  }

  const header = long
    ? Buffer.from([
        0x79, 0x79,
        (length >>> 8) & 255,
        length & 255
      ])
    : Buffer.from([0x78, 0x78, length]);

  const crcInput = Buffer.concat([
    header.subarray(2),
    body
  ]);

  const crc = crc16X25(crcInput);

  return Buffer.concat([
    header,
    body,
    Buffer.from([
      (crc >>> 8) & 255,
      crc & 255,
      0x0d,
      0x0a
    ])
  ]);
}

// =====================================================
// DISPOSITIVOS
// =====================================================

function device(imei) {
  if (!devices.has(imei)) {
    devices.set(imei, {
      imei,
      online: false,
      lastSeenAt: null,
      ignition: null,
      terminalInfo: null,
      location: null,
      relay: {
        state: 'unknown',
        confirmed: false,
        requested: null,
        delivery: 'none',
        sequence: null,
        response: null,
        updatedAt: null,
        note: 'Estado físico do relé não confirmado'
      }
    });
  }

  return devices.get(imei);
}

function parseIMEI(packet, offset) {
  return packet
    .subarray(offset, offset + 8)
    .toString('hex')
    .slice(1);
}

function getActiveSession(imei) {
  const candidates = [...sessions.values()]
    .filter(s =>
      s.imei === imei &&
      !s.socket.destroyed &&
      s.socket.writable
    )
    .sort((a, b) => b.lastPacketAt - a.lastPacketAt);

  return candidates[0] || null;
}

function refreshOnline(imei) {
  const d = devices.get(imei);
  if (d) d.online = Boolean(getActiveSession(imei));
}

// =====================================================
// GPS
// =====================================================

function parseGPS(packet, offset) {
  if (packet.length < offset + 18) return null;

  const year = 2000 + packet[offset];
  const month = packet[offset + 1];
  const day = packet[offset + 2];
  const hour = packet[offset + 3];
  const minute = packet[offset + 4];
  const second = packet[offset + 5];

  if (
    month < 1 || month > 12 ||
    day < 1 || day > 31 ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }

  let latitude =
    packet.readUInt32BE(offset + 7) / 1800000;

  let longitude =
    packet.readUInt32BE(offset + 11) / 1800000;

  const speed = packet[offset + 15];
  const flags = packet.readUInt16BE(offset + 16);

  if (!(flags & 0x0400)) latitude = -latitude;
  if (flags & 0x0800) longitude = -longitude;

  if (
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180 ||
    (!latitude && !longitude)
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    speed,
    satellites: packet[offset + 6] & 15,
    gpsUtc: new Date(Date.UTC(
      year, month - 1, day,
      hour, minute, second
    )).toISOString(),
    receivedAt: iso(),
    map: `https://www.google.com/maps?q=${latitude},${longitude}`
  };
}

// =====================================================
// REGISTRO DE RESPOSTAS
// =====================================================

function pushResponse(response) {
  responses.push(response);

  if (responses.length > MAX_RESPONSES) {
    responses.shift();
  }

  log({
    type: 'protocol_response',
    ...response
  });
}

// =====================================================
// DISCORD
// =====================================================

function notifyDiscord(imei, message, location) {
  if (!DISCORD_WEBHOOK) return;

  let url;

  try {
    url = new URL(DISCORD_WEBHOOK);

    if (
      url.protocol !== 'https:' ||
      !['discord.com', 'discordapp.com']
        .includes(url.hostname)
    ) {
      return;
    }
  } catch {
    return;
  }

  const content =
    `TP7 ${imei}: ${message}` +
    (location ? `\n${location.map}` : '');

  const body = Buffer.from(JSON.stringify({
    content,
    allowed_mentions: { parse: [] }
  }));

  const req = https.request(url, {
    method: 'POST',
    timeout: 8000,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    }
  }, res => res.resume());

  req.on('error', err => {
    console.error('[DISCORD]', err.message);
  });

  req.on('timeout', () => req.destroy());
  req.end(body);
}

// =====================================================
// ACK
// =====================================================

function ack(socket, protocol, sequence) {
  if (socket.writable && !socket.destroyed) {
    const packet = frame(
      protocol,
      Buffer.alloc(0),
      sequence
    );

    socket.write(packet);
    console.log('[ACK]', packet.toString('hex'));
  }
}

// =====================================================
// PROCESSAMENTO DE PACOTES
// =====================================================

function processPacket(socket, session, packet, long) {
  const offset = long ? 4 : 3;
  const protocol = packet[offset];

  const sequence = packet.readUInt16BE(
    packet.length - 6
  );

  const raw = packet.toString('hex');

  session.lastPacketAt = Date.now();

  console.log('[RX]', hexByte(protocol), raw);

  log({
    at: iso(),
    type: 'rx',
    imei: session.imei,
    protocol: hexByte(protocol),
    hex: raw
  });

  // LOGIN 0x01

  if (protocol === 0x01) {
    const imei = parseIMEI(packet, offset + 1);

    session.imei = imei;
    session.device = device(imei);

    session.device.online = true;
    session.device.lastSeenAt = iso();

    console.log('[LOGIN]', imei);
    ack(socket, protocol, sequence);
    return;
  }

  if (!session.imei) {
    console.log('[RX SEM LOGIN]', hexByte(protocol));
    return;
  }

  const d = session.device;
  d.lastSeenAt = iso();
  d.online = true;

  // HEARTBEAT 0x13

  if (protocol === 0x13) {
    const terminalInfo = packet[offset + 1];

    d.terminalInfo = {
      hex: hexByte(terminalInfo),
      binario: terminalInfo.toString(2).padStart(8, '0'),
      bit01: Boolean(terminalInfo & 0x01),
      bit02: Boolean(terminalInfo & 0x02),
      bit80: Boolean(terminalInfo & 0x80),
      at: iso(),
      confirmedAsRelay: false
    };

    if (HEARTBEAT_ACC_BIT) {
      const ignition = Boolean(terminalInfo & 0x02);
      const previous = d.ignition;

      d.ignition = ignition;

      if (
        previous !== null &&
        previous !== ignition
      ) {
        notifyDiscord(
          d.imei,
          'Ignição ' + (ignition ? 'ligada' : 'desligada'),
          d.location
        );
      }

      console.log(
        '[IGNITION]',
        ignition ? 'ON' : 'OFF'
      );
    }

    ack(socket, protocol, sequence);
    return;
  }

  // GPS 0x12 / 0x22

  if (protocol === 0x12 || protocol === 0x22) {
    const location = parseGPS(packet, offset + 1);

    if (location) {
      d.location = location;
      lastLocation = {
        imei: d.imei,
        ...location
      };

      console.log(
        '[GPS]',
        location.latitude,
        location.longitude,
        location.map
      );

      notifyDiscord(
        d.imei,
        'Localização atualizada',
        location
      );
    }

    return;
  }

  // RESPOSTAS DE COMANDOS

  if (
    protocol === 0x15 ||
    protocol === 0x21 ||
    protocol === 0x80
  ) {
    const response = {
      at: iso(),
      imei: d.imei,
      protocol: hexByte(protocol),
      sequence,
      hex: raw,
      asciiCandidate: packet
        .subarray(offset + 1, packet.length - 6)
        .toString('latin1'),
      interpretation:
        'Resposta recebida; significado e estado físico não confirmados'
    };

    pushResponse(response);

    d.relay.response = response;
    d.relay.delivery = 'response_received_unverified';
    d.relay.updatedAt = iso();

    console.log(
      '[COMMAND RESPONSE]',
      JSON.stringify(response)
    );

    return;
  }

  // PROTOCOLO 0x94

  if (protocol === 0x94) {
    const response = {
      at: iso(),
      imei: d.imei,
      protocol: '0x94',
      sequence,
      hex: raw,
      interpretation:
        'Pacote 0x94 capturado para diagnóstico'
    };

    pushResponse(response);

    console.log('[RX 0x94]', JSON.stringify(response));
    return;
  }

  // ALARME 0x16

  if (protocol === 0x16) {
    console.log('[ALARM 0x16]', raw);
    return;
  }

  console.log('[UNKNOWN PROTOCOL]', hexByte(protocol));
}

// =====================================================
// PARSER TCP GT06
// SUPORTA 7878 E 7979
// =====================================================

function consume(socket, session, chunk) {
  session.buffer = Buffer.concat([
    session.buffer,
    chunk
  ]);

  if (session.buffer.length > 65536) {
    console.error('[BUFFER OVERFLOW]');
    socket.destroy();
    return;
  }

  while (session.buffer.length >= 5) {
    const b = session.buffer;
    let start = -1;

    for (let i = 0; i < b.length - 1; i++) {
      if (
        (b[i] === 0x78 && b[i + 1] === 0x78) ||
        (b[i] === 0x79 && b[i + 1] === 0x79)
      ) {
        start = i;
        break;
      }
    }

    if (start === -1) {
      session.buffer = b.subarray(b.length - 1);
      return;
    }

    if (start > 0) {
      session.buffer = b.subarray(start);
      continue;
    }

    const long = b[0] === 0x79;

    if (long && b.length < 6) return;

    const length = long
      ? b.readUInt16BE(2)
      : b[2];

    const packetSize = length + (long ? 6 : 5);

    if (
      packetSize < (long ? 11 : 10) ||
      packetSize > 65536
    ) {
      session.buffer = b.subarray(1);
      continue;
    }

    if (b.length < packetSize) return;

    const packet = b.subarray(0, packetSize);

    const stopOK =
      packet[packetSize - 2] === 0x0d &&
      packet[packetSize - 1] === 0x0a;

    const receivedCRC = packet.readUInt16BE(
      packetSize - 4
    );

    const calculatedCRC = crc16X25(
      packet.subarray(2, packetSize - 4)
    );

    if (!stopOK || receivedCRC !== calculatedCRC) {
      console.warn(
        '[INVALID FRAME]',
        packet.toString('hex')
      );

      session.buffer = b.subarray(1);
      continue;
    }

    session.buffer = b.subarray(packetSize);

    try {
      processPacket(socket, session, packet, long);
    } catch (err) {
      console.error('[PACKET ERROR]', err.message);
    }
  }
}

// =====================================================
// SERVIDOR TCP
// =====================================================

const tcp = net.createServer(socket => {
  const session = {
    id: crypto.randomUUID(),
    socket,
    imei: null,
    device: null,
    buffer: Buffer.alloc(0),
    connectedAt: Date.now(),
    lastPacketAt: Date.now()
  };

  sessions.set(session.id, session);

  console.log(
    '[CONNECT]',
    socket.remoteAddress,
    socket.remotePort
  );

  socket.setTimeout(180000);

  socket.on('data', data => {
    consume(socket, session, data);
  });

  socket.on('timeout', () => {
    console.log('[SOCKET TIMEOUT]', session.imei);
    socket.destroy();
  });

  socket.on('error', err => {
    console.error('[SOCKET]', err.message);
  });

  socket.on('close', () => {
    sessions.delete(session.id);

    if (session.imei) {
      refreshOnline(session.imei);
    }

    console.log('[DISCONNECT]', session.imei);
  });
});

tcp.listen(TCP_PORT, '0.0.0.0', () => {
  console.log('[TCP]', TCP_PORT);
});

// =====================================================
// COMANDOS HEX DO RELÉ
// =====================================================

// BLOQUEAR:
// RELAY,1#
// 52 45 4C 41 59 2C 31 23
//
// DESBLOQUEAR:
// RELAY,0#
// 52 45 4C 41 59 2C 30 23
//
// O CRC e o serial são gerados automaticamente.
// Não utilizar o CRC fixo dos exemplos recebidos.

function buildOnlineCommand(command, sequence) {
  if (![RELAY_ON_CMD, RELAY_OFF_CMD].includes(command)) {
    throw new Error('Comando de relé não permitido');
  }

  const ascii = Buffer.from(command, 'ascii');

  // Formato experimental 0x80:
  // 78 78
  // LENGTH
  // 80
  // COMMAND_LENGTH
  // SERVER_FLAG (4 bytes)
  // ASCII
  // SERIAL (2 bytes)
  // CRC (2 bytes)
  // 0D 0A

  const content = Buffer.concat([
    Buffer.from([SERVER_FLAG.length + ascii.length]),
    SERVER_FLAG,
    ascii
  ]);

  return frame(0x80, content, sequence);
}

// =====================================================
// ENVIO DO COMANDO
// =====================================================

function sendCommand(imei, command, action) {
  const session = getActiveSession(imei);

  if (!session) {
    return {
      status: 409,
      body: {
        ok: false,
        error: 'Rastreador offline ou sem conexão TCP ativa'
      }
    };
  }

  const sequence = nextSerial();
  const packet = buildOnlineCommand(command, sequence);
  const packetHex = packet.toString('hex');
  const d = session.device;

  d.relay = {
    state: 'unknown',
    confirmed: false,
    requested: action,
    command,
    delivery: 'writing_to_socket',
    sequence,
    response: null,
    updatedAt: iso(),
    note:
      'Aguardando resposta; estado físico não confirmado'
  };

  session.socket.write(packet, err => {
    d.relay.delivery = err
      ? 'socket_error'
      : 'written_to_socket';

    d.relay.updatedAt = iso();

    if (err) d.relay.note = err.message;
  });

  console.log(
    '[TX EXPERIMENTAL]',
    imei,
    action,
    packetHex
  );

  console.log('[TX ASCII]', command);

  log({
    at: iso(),
    type: 'tx_experimental',
    imei,
    action,
    command,
    sequence,
    hex: packetHex
  });

  return {
    status: 202,
    body: {
      ok: true,
      commandQueued: true,
      physicalRelayConfirmed: false,
      requested: action,
      command,
      sequence,
      packetHex,
      relay: d.relay,
      warning:
        'Pacote enviado para teste; relé não confirmado'
    }
  };
}

// =====================================================
// RESPOSTA JSON
// =====================================================

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });

  res.end(JSON.stringify(obj, null, 2));
}

// =====================================================
// AUTENTICAÇÃO
// =====================================================

function authorized(req) {
  if (!API_KEY) {
    return (
      HTTP_HOST === '127.0.0.1' ||
      HTTP_HOST === '::1'
    );
  }

  const header = req.headers.authorization || '';

  const supplied = header.startsWith('Bearer ')
    ? header.slice(7)
    : '';

  const a = Buffer.from(supplied);
  const b = Buffer.from(API_KEY);

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

// =====================================================
// API HTTP
// =====================================================

const api = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (!authorized(req)) {
    return sendJSON(res, 401, {
      error: 'Acesso não autorizado'
    });
  }

  const requestedIMEI = url.searchParams.get('imei');

  const imei =
    requestedIMEI ||
    [...devices.keys()][0];

  const d = imei ? devices.get(imei) : null;

  // DOCUMENTAÇÃO

  if (req.method === 'GET' && url.pathname === '/docs') {
    return sendJSON(res, 200, {
      name: 'TP7 4G - API experimental',
      endpoints: [
        'GET /status',
        'GET /location',
        'GET /ignition/status',
        'GET /relay/status',
        'GET /relay/diagnostic',
        'GET /protocol/responses',
        'GET /relay/on',
        'GET /relay/off'
      ],
      optional: '?imei=SEU_IMEI',
      relayCommands: {
        on: RELAY_ON_CMD,
        off: RELAY_OFF_CMD
      },
      note:
        'Estado físico do relé exige confirmação externa.'
    });
  }

  // STATUS GERAL

  if (req.method === 'GET' && url.pathname === '/status') {
    return sendJSON(res, 200, {
      online: [...devices.values()]
        .filter(d => d.online).length,
      experimentalRelayEnabled:
        ENABLE_EXPERIMENTAL_RELAY,
      devices: [...devices.values()]
    });
  }

  // LOCALIZAÇÃO

  if (req.method === 'GET' && url.pathname === '/location') {
    return sendJSON(
      res,
      200,
      d?.location
        ? { imei, ...d.location }
        : lastLocation || { available: false }
    );
  }

  // IGNIÇÃO

  if (
    req.method === 'GET' &&
    url.pathname === '/ignition/status'
  ) {
    return sendJSON(res, 200, {
      imei,
      ignition: d?.ignition ?? null,
      lastSeenAt: d?.lastSeenAt ?? null
    });
  }

  // STATUS RELÉ

  if (
    req.method === 'GET' &&
    url.pathname === '/relay/status'
  ) {
    return sendJSON(res, 200, {
      imei,
      online: d?.online ?? false,
      relay: d?.relay || {
        state: 'unknown',
        confirmed: false
      },
      terminalInfo: d?.terminalInfo || null
    });
  }

  // DIAGNÓSTICO

  if (
    req.method === 'GET' &&
    url.pathname === '/relay/diagnostic'
  ) {
    return sendJSON(res, 200, {
      imei,
      online: d?.online ?? false,
      relay: d?.relay || null,
      terminalInfo: d?.terminalInfo || null,
      warning:
        'Respostas e bits devem ser validados para este firmware.'
    });
  }

  // RESPOSTAS DO PROTOCOLO

  if (
    req.method === 'GET' &&
    url.pathname === '/protocol/responses'
  ) {
    const filtered = requestedIMEI
      ? responses.filter(r => r.imei === requestedIMEI)
      : responses;

    return sendJSON(res, 200, {
      count: filtered.length,
      packets: filtered
    });
  }

  // BLOQUEIO / DESBLOQUEIO

  if (
    req.method === 'GET' &&
    (
      url.pathname === '/relay/on' ||
      url.pathname === '/relay/off'
    )
  ) {
    if (!ENABLE_EXPERIMENTAL_RELAY) {
      return sendJSON(res, 403, {
        ok: false,
        error:
          'ENABLE_EXPERIMENTAL_RELAY não está habilitado'
      });
    }

    if (!d) {
      return sendJSON(res, 404, {
        ok: false,
        error: 'Rastreador não identificado'
      });
    }

    const on = url.pathname === '/relay/on';

    const action = on ? 'on' : 'off';

    const command = on
      ? RELAY_ON_CMD
      : RELAY_OFF_CMD;

    try {
      const result = sendCommand(
        imei,
        command,
        action
      );

      return sendJSON(
        res,
        result.status,
        result.body
      );
    } catch (err) {
      console.error('[RELAY ERROR]', err.message);

      return sendJSON(res, 500, {
        ok: false,
        error: err.message
      });
    }
  }

  return sendJSON(res, 404, {
    error: 'Rota não encontrada',
    docs: '/docs'
  });
});

// =====================================================
// INICIAR API
// =====================================================

api.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log('[HTTP]', HTTP_HOST, HTTP_PORT);

  console.log(
    '[DOCS]',
    `http://${HTTP_HOST}:${HTTP_PORT}/docs`
  );

  console.log(
    '[RELAY ON]',
    `http://${HTTP_HOST}:${HTTP_PORT}/relay/on`
  );

  console.log(
    '[RELAY OFF]',
    `http://${HTTP_HOST}:${HTTP_PORT}/relay/off`
  );

  console.log(
    '[RELAY STATUS]',
    `http://${HTTP_HOST}:${HTTP_PORT}/relay/status`
  );
});
