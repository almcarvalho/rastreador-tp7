# 📡 Rastreamento GPS com Servidor Próprio (Node.js)

Projeto experimental para criar seu próprio sistema de rastreamento GPS utilizando uma VPS, Node.js e comunicação TCP com rastreadores compatíveis com o protocolo GT06.
Eu usei um rastreador J16, atente-se para comprar ele DESBLOQUEADO. A maioria das empresas vende ele bloqueado, sendo necessário pagar pra elas ou geralmente aguardar 3 meses pagando as plataformas deles
aí eles liberam. Apenas rastreadores desbloqueados você consegue enviar o sms pra alterar ip e porta, os bloqueados você não consegue, precisa desbloquear para permitir mudar.

<img width="1127" height="749" alt="image" src="https://github.com/user-attachments/assets/67df1706-44fc-469f-9d2e-af581f2a8c54" />

<img width="1172" height="1342" alt="image" src="https://github.com/user-attachments/assets/2086619c-125d-461b-b73e-a53f9a5d27e2" />

Envio de notificações através de webhooks no aplicativo Discord:

<img width="1254" height="1254" alt="image" src="https://github.com/user-attachments/assets/c3e5c176-0605-4970-bf67-86a5d2c8c2fa" />


## 🚀 Como começar

1. **Compre um rastreador GPS**, de preferência desbloqueado, que permita configurar IP e porta do servidor.

2. **Contrate uma VPS.** No meu caso, utilizei a Wyze, com Windows Server, em um plano de aproximadamente R$ 80/mês.

https://www.wyzehost.com.br/vps

3. **Instale o Node.js** na VPS e reinicie o servidor após a instalação.

4. **Abra o projeto no Visual Studio Code (VS Code)** e instale as dependências:

   ```bash
   npm install
   npm install dotenv
   ```

5. **Configure a aplicação** e libere a porta `3003` (TCP) no firewall da VPS (configurações de firewall avançadas).

6. **Inicie o projeto** pelo terminal do VS Code:

   ```bash
   npm run dev
   ```

   Lembre de renomear o arquivo .env.example para somente .env antes de rodar

   Para parar o terminal utilize ctrl + C

7. **Configure o rastreador via SMS**, apontando para o IP público e a porta da VPS.

   Exemplo:

   ```text
   IP,SEU_IP_PUBLICO,3003#
   ```

   O comando pode variar conforme o modelo do rastreador.

8. **Pronto!** Seu rastreador poderá enviar dados diretamente para seu servidor.

## 📡 Como funciona o protocolo GT06?

O GT06 é um protocolo de comunicação utilizado por diversos rastreadores GPS para trocar informações com servidores através de conexões TCP.

Os dispositivos enviam pacotes em formato hexadecimal (HEX), contendo informações como identificação, localização, status e eventos.

### Exemplo de comunicação real

```text
[RX] 0x13 78780a1345060400010322f4940d0a
[IGNITION] OFF
[ACK] 787805130322d0000d0a
```

**Entendendo os registros:**

- `RX`: pacote recebido do rastreador.
- `0x01`: identificação/login do dispositivo.
- `0x13`: heartbeat, utilizado para informar o estado do equipamento.
- `IGNITION OFF`: ignição interpretada como desligada.
- `ACK`: confirmação enviada pelo servidor.
- `CONNECT`: rastreador estabeleceu uma conexão TCP.
- `DISCONNECT`: conexão encerrada.
- `SOCKET TIMEOUT`: conexão encerrada após período sem comunicação.

### Estrutura básica de um pacote GT06

Exemplo simplificado:

```text
78 78 | 0A | 13 | ... | CRC | 0D 0A
```

- `78 78`: início do pacote.
- `0A`: comprimento informado no pacote.
- `13`: tipo de protocolo (heartbeat).
- `...`: dados e número de sequência.
- `CRC`: verificação de integridade.
- `0D 0A`: finalização do pacote.

O servidor interpreta os pacotes recebidos e responde com ACK quando necessário.

**Observação:** o status de ignição depende da interpretação dos bits do equipamento e deve ser validado conforme seu firmware.

## 🛠️ Funcionalidades

- Recebimento de pacotes GPS via TCP.
- Identificação dos rastreadores pelo IMEI.
- Consulta de localização e status via API HTTP (porta `3001`).
- Monitoramento de ignição.
- Notificações via Discord.
- Testes experimentais de acionamento e desacionamento do relé.

## 📚 Documentação técnica para IA

**[GT06 GPS Tracker Communication Protocol v1.8.1](https://www.traccar.org/protocol/5023-gt06/GT06_GPS_Tracker_Communication_Protocol_v1.8.1.pdf)**

Documento útil para fornecer à inteligência artificial durante o desenvolvimento.

Ajuda a compreender a estrutura dos pacotes, códigos de protocolo, respostas ACK, cálculo CRC e comandos relacionados ao corte e à restauração da ignição.

**Atenção:** os comandos de relé podem variar conforme o firmware. É necessário validar os comandos com o manual específico do rastreador. O recebimento de uma resposta não garante que o relé tenha sido fisicamente acionado. Testes de corte devem ser feitos apenas em condições seguras, com o veículo parado.

## 💡 Conclusão

Com um rastreador, uma VPS e um pouco de programação, você pode desenvolver seu próprio sistema de rastreamento, sem depender de plataformas prontas!

**LC Sistemas — Compartilhando Conhecimento, IoT e Cultura Maker 🚀**
