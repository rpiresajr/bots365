# WhatsApp EVA Integration

This project integrates WhatsApp's Cloud API with EVA AI platform, enabling automated conversations through WhatsApp using EVA's natural language processing capabilities. The system supports both text and voice messages, with automatic speech-to-text conversion for audio messages.

## Features

- WhatsApp message webhook handling
- Session management with timeout
- Text message processing
- Voice message processing with speech-to-text
- Automatic session expiration notifications
- Docker support

## Deploy para demais ambientes QA e PRD

Segue a seguencia para o DEPLOY em PRD DEVELOP :  -> QA -> MAIN (prd)

## Para configurar um bot precisamos ter uma URL que retorne as configurações para bot ex:
```
URL: https://env1.evamotor.com.br/api/config
api-key: 27f86be38778541f0b84f24acf58de8a98488e97
Resultado: 
```
```
{
    "465670666628566": { // Identificação do número de telefone META
        "auth": { // Credenciais do EVA
            "client_id": "6f146ae5-c0a6-4d75-987a-382b79e17d3d", 
            "host": "https://env1.evamotor.com.br",
            "password": "password"
        },
        "bot": { // Configurações do bot
            "cl": "1",
            "engine": "azure",
            "expiredSessionMessage": "Sua sessão expirou!",
            "greetingMessage": "Se apresente de maneira informal para o usuário falando sobre é um assistente virtual especializado da empresa e irá ajudá-lo",
            "replyAudioType": "audio",
            "searchDocs": "true",
            "sessionTimeout": 60000,
            "temperature": 0.2,
            "unexpectedError": "Ocorreu um erro inesperado, por favor tente novamente mais tarde."
        },
        "sqs": { // Configurações do SQS
            "accessKeyId": "AKIAZ63FGA7LG3HPIZED",
            "batchSize": 5,
            "region": "us-east-1",
            "secretAccessKey": "6xRd6xrStEiHAZfiY8Wy5zzY/JDxoVPBzS4kHoUp",
            "url": "https://sqs.us-east-1.amazonaws.com/684722620374/eva_queue.fifo"
        },
        "whatsapp": { // Configurações do WhatsApp
            "blackList": [],
            "displayPhoneNumber": "5511997184855", // Número de telefone do WhatsApp
            "phoneNumberId": "465670666628566", // Identificação do número de telefone META
            "token": "EAAIsyarofIYBO0VBDLxlps5By8HCusJmWwQuw90VrFz13gA5rDW86d8wEFRvoFdRIeNSx1nipnnE208S1StjhdsVIYFL1kD0i6zO7ObiN1PcIAASk3rGgylcmeaLZBT2TRFqpPDj3Lwdlprs6PnTqpJb833You1T4F62ZBSZADlEUlImwbMWpE0tTIRbBL77AZDZD", // Token do vitálicio META
            "url": "https://graph.facebook.com", // URL do WhatsApp
            "version": "v16.0", // Versão do WhatsApp
            "whiteList": []
        }
    }
}
```
### Whitelist/blacklist
```
Basta adicionar o número de telefone no array, o número de telefone deve ser adicionado no formato internacional, ex: 5511997184855, é importante colocar váriação com 9 na frente do número e sem ex:
whiteList: ["557999597351","5579999597351"]
```

## Com url basta passar parâmetros para o bot conforme exemplo abaixo

### Consumer

```
cd eva-whatsapp/consumer
docker build -t eva-whatsapp-consumer .  --no-cache
docker run -d --name eva-whatsapp-consumer --restart always -p 8502:8080 -e PORT=8080 -e EVA_URL=https://env1.evamotor.com.br/api/config -e EVA_API_KEY=27f86be38778541f0b84f24acf58de8a98488e97 eva-whatsapp-consumer
```

### Producer

```
cd eva-whatsapp/producer
docker build -t eva-whatsapp-producer .  --no-cache
docker run -d --name eva-whatsapp-producer --restart always -p 8501:8080 -e PORT=8080 -e EVA_URL=https://env1.evamotor.com.br/api/config -e EVA_API_KEY=27f86be38778541f0b84f24acf58de8a98488e97  -e WHATSAPP_WEBHOOK_TOKEN=my-test-token eva-whatsapp-producer
```

