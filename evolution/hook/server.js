require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const logger = require('./logger');
const fs = require('fs');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 8898;

const sessionMap = new Map();
const timeoutMap = new Map();
const INACTIVITY_LIMIT = 10 * 60 * 1000;

const MessageType = Object.freeze({
  AUDIO: 'audioMessage',
  TEXT: 'conversation',
});

let token_api;


async function getFrontEnd(token_api) {
  logger.info(`Buscando dados frontEnd ... ${process.env.API_BASE_URL}/api/workspace usando o token: ${token_api}`);
  const res = await fetch(`${process.env.API_BASE_URL}/api/workspace`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json',
               'Authorization': `Bearer ${token_api}` }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Falha ao buscar info do workspace (${res.status} ${res.statusText})`);
  }

  const data = await res.json().catch(() => ({}));

  logger.info(data);
  const frontend = data?.frontend ?? null;
  if (!frontend) throw new Error('Resposta não contém o objeto frontend.');
  
  return frontend; // <- exatamente no formato { token: "xxxx" }
}



async function getToken() {
  const login = `${process.env.API_USERNAME}`;
  const password = `${process.env.API_PASSWORD}`;

  const res = await fetch(`${process.env.API_BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Falha no login (${res.status} ${res.statusText}): ${body}`);
  }

  const data = await res.json().catch(() => ({}));
  logger.info("retornando ....");
  logger.info(data);
  const token = typeof data?.token === 'string' ? data.token : null;
  if (!token) throw new Error('Resposta não contém "message" com o token.');
  
  return token; // <- exatamente no formato { token: "xxxx" }
}

app.use(bodyParser.json());

async function sendWhatsappMessage(number, instance, text) {
  logger.info(`📨 Enviando mensagem para ${number}: "${text}".   ${process.env.EVOLUTION_BASE_URL}/message/sendText/${instance}`);
  try {
    const response = await axios.post(
      `${process.env.EVOLUTION_BASE_URL}/message/sendText/${instance}`,
      {
        number,
        text,
        mentionsEveryOne: true,
        mentioned: [number],
      },
      {
        headers: { apikey: process.env.EVOLUTION_APIKEY },
      }
    );
    logger.info(`✅ Mensagem enviada com sucesso para ${number}`);
    return response.data;
  } catch (err) {
    logger.error(err, `❌ Erro ao enviar mensagem: ${err.message}`);
  }
}

async function sendWhatsappAudioMessage(number, instance, text, keyspace, token) {
  //let token_api;
  try {
    token_api = await getToken();
    logger.info({ token_api });
  } catch (err) {
    logger.error(err);
  }
  const response = await axios({
    method: 'POST',
    url: `${process.env.API_BASE_URL}/api/speech/from-text`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token_api}`,
    },
    data: {
      text,
      language: 'pt',
    },
    responseType: 'arraybuffer',
  });
  const base64Audio = Buffer.from(response.data, 'binary').toString('base64');

  logger.info(`📨 Enviando mensagem para ${number}: "${text}"`);
  try {
    const response = await axios.post(
      `${process.env.EVOLUTION_BASE_URL}/message/sendWhatsAppAudio/${instance}`,
      {
        number,
        'audio': base64Audio,
        mentionsEveryOne: true,
        mentioned: [number],
      },
      {
        headers: { apikey: process.env.EVOLUTION_APIKEY },
      }
    );
    logger.info(`✅ Mensagem enviada com sucesso para ${number}`);
    return response.data;
  } catch (err) {
    logger.error(err, `❌ Erro ao enviar mensagem: ${err.message}`);
  }
}

function resetInactivityTimer(number, instance, sessionid, token) {
  logger.info(`⏱️ Resetando timer de inatividade para ${number}`);
  if (timeoutMap.has(number)) {
    clearTimeout(timeoutMap.get(number));
    logger.info(`🔁 Timer anterior cancelado para ${number}`);
  }

  const timeout = setTimeout(async () => {
    logger.info(
      `⌛ Inatividade detectada para ${number}, encerrando atendimento.`
    );
    const text =
      'Opa! Já passamos 10 minutinhos aqui, então vou encerrar o atendimento por agora. Se precisar de mais alguma coisa, é só chamar. Até mais!';
    await sendWhatsappMessage(number, instance, text);
    sessionMap.delete(number);
    timeoutMap.delete(number);
    logger.info(`🧹 Sessão e timer removidos para ${number}`);
  }, INACTIVITY_LIMIT);

  timeoutMap.set(number, timeout);
}

async function getEnvironmentSettings(instance) {
  const environmentName = instance.split('-').slice(1).join('-');
  const keyspaceName = instance.split('-')[0];

  logger.info(
    `🔎 Buscando settings para environment: ${environmentName} e keyspace: ${keyspaceName}`
  );



  let parsedSettings = {
        "whatsapp_webhook_token": process.env.EVOLUTION_APIKEY,
	"clientId": process.env.EVOLUTION_INSTANCE
   }

  logger.info(
    `✅ Settings carregados para ${environmentName}:`,
    parsedSettings
  );

  return {
    token: parsedSettings.whatsapp_webhook_token,
    clientId: parsedSettings.eva_client_id,
    keyspace: keyspaceName,
  };
}

async function handleAudioMessage(messageBody, token, keyspace) {
  logger.info(`===== 🎙️ AUDIO MESSAGE =====`, messageBody);
}

async function getAudioMessageData(instance, messageId) {
  const response = await axios({
    method: 'POST',
    url: `${process.env.EVOLUTION_BASE_URL}/chat/getBase64FromMediaMessage/${instance}`,
    data: {
      message: {
        key: {
          id: messageId,
        },
      },
      convertToMp4: true,
    },
    headers: {
      apikey: process.env.EVOLUTION_APIKEY,
      'Content-Type': 'application/json',
    },
  });
  return response.data?.base64;
}

async function getTextFromAudioFile(audioFilePath, token, keyspace) {
  try {
    const formData = new FormData();
    formData.append('audio', fs.createReadStream(audioFilePath));
    formData.append('language', 'pt_BR');

    //let token_api;
    try {
      token_api = await getToken();
      logger.info({ token_api });
    } catch (err) {
      logger.error(err);
    }

    const evaResponse = await axios({
      method: 'POST',
      url: `${process.env.API_BASE_URL}/api/speech/from-audio`,
      headers: {
        Authorization: `Bearer ${token_api}`,
        ...formData.getHeaders(),
      },
      data: formData,
    });
    logger.info(`Eva response: ${JSON.stringify(evaResponse.data, null, 2)}`);

    return evaResponse?.data?.text;
  } catch (error) {
    logger.error(error, `Error getting audio message:`, error.message);
    logger.error(error, `Error processing audio:`, error.message);
  } finally {
    if (audioFilePath && fs.existsSync(audioFilePath)) {
      fs.unlinkSync(audioFilePath);
      logger.info(`Cleaned up temporary file: ${audioFilePath}`);
    }
  }
}

app.use(async (req, res, next) => {
  try {
    logger.info(`===== 📥 NOVA REQUISIÇÃO =====`);
    logger.info({
      headers: req.headers,
      body: req.body,
    });

    if (!req.body || req.body.event !== 'messages.upsert') {
      logger.warn(`⚠️ Requisição ignorada: evento não suportado.`);
      return next();
    }
    const instance = req.body.instance;
    const { token, clientId, keyspace } =
      await getEnvironmentSettings(instance);
    const number = req.body.data?.key?.remoteJid?.replace(/\D/g, '');
    let message = req.body.data?.message?.conversation;
    const isAudioMessage = req.body.data?.messageType == MessageType.AUDIO
    if (isAudioMessage) {
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-');
      let fileName = `${timestamp}.ogg`;
      const messageId = req.body.data?.key?.id;
      let mediaData = await getAudioMessageData(instance, messageId);
      const mediaDataBuffer = Buffer.from(mediaData, 'base64');
      fs.writeFileSync(fileName, mediaDataBuffer);
      message = await getTextFromAudioFile(fileName, token, keyspace);
    }

    if (!number || !message || !instance) {
      logger.warn(
        `⚠️ Dados incompletos: número, mensagem ou instância ausente.`
      );
      return next();
    }

    logger.info(`📲 Mensagem recebida de ${number}: "${message}"`);

    const isFirstMessage = !sessionMap.has(number);
    const sessionid = sessionMap.get(number) || '';

    //let token_api;
    try {
      token_api = await getToken();
      logger.info({ token_api });
    } catch (err) {
      logger.error(err);
    }

    let payload, template;

    const frontend = getFrontEnd(token_api);

    if (isFirstMessage) {

      const memory_saudacao = typeof frontend?.memory_saudacao === 'string' ? frontend.memory_saudacao : 'Você é um chatbot, conversando como um humano, de forma amigável. Nunca coloque a frase de saudação em negrito.';

      template = 'template_saudacao';
      payload = {
        memory: JSON.stringify({
          role: 'system',
          content:
            memory_saudacao
        }),
        query: message,
        searchdocs: false,
        temperature: '0.9',
        template,
	      email: false,
	      zendesk: false,
        client_id: clientId,
        sessionid: '',
        username: `WHATSAPP - {{${number}}}`,
      };
      logger.info(`👋 Primeira mensagem recebida. Template: ${template} Memoria_Saudacao: ${memory_saudacao}`);
    } else {
      const temperature = typeof frontend?.temperature === 'string' ? frontend.temperature : '0.2';
      template = 'template_contexto';
      payload = {
        query: message,
        memory: '{}',
        searchdocs: true,
        temperature,
        template,
        client_id: clientId,
        email: false,
        zendesk: false,
        sessionid,
        username: `WHATSAPP - {{${number}}}`,
        cl: '1',
        engine: 'azure',
      };
      logger.info(`💬 Mensagem de sequência. Template: ${template}  Temperatura: ${temperature}`);
    }

    const askUrl = `${process.env.API_BASE_URL}/api/ai/ask`;
    logger.info(`📡 Enviando para: ${askUrl}`);
    //logger.info(payload);
    logger.info(`📦 Payload:`, JSON.stringify(payload));
    //logger.info(`📦 Payload:`, payload);
    
    logger.info("Realizando o ask")
    const askResponse = await axios.post(askUrl, payload, {
      headers: { Authorization: `Bearer ${token_api}` },
    });

    const botMessage = askResponse.data?.message || 'Não entendi sua pergunta.';
    logger.info(`🤖 Resposta do bot: "${botMessage}"`);

    if (isFirstMessage && askResponse.data?.sessionid) {
      sessionMap.set(number, askResponse.data.sessionid);
      logger.info(
        `💾 Sessão criada: ${number} -> ${askResponse.data.sessionid}`
      );
    }
    if (isAudioMessage) {
      await sendWhatsappAudioMessage(number, instance, botMessage, keyspace, token);
    } else {
      await sendWhatsappMessage(number, instance, botMessage);
    }
    
    resetInactivityTimer(number, instance, sessionid, token);
  } catch (error) {
    logger.error(error, '❌ Erro no middleware de mensagens:', error.stack);
  }

  next();
});

app.all('*', (req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  logger.info(`🚀 Webhook rodando na porta ${PORT}`);
});
