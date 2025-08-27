require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cassandra = require('cassandra-driver');
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

logger.info(`⏳ Conectando ao Cassandra...`);
const cassandraClient = new cassandra.Client({
  contactPoints: [process.env.CASSANDRA_HOST],
  localDataCenter: process.env.CASSANDRA_NAME,
  keyspace: process.env.CASSANDRA_KEYSPACE,
  protocolOptions: { port: parseInt(process.env.DB_PORT, 10) },
  authProvider: new cassandra.auth.PlainTextAuthProvider(
    process.env.CASSANDRA_USERNAME,
    process.env.CASSANDRA_PASSWORD
  ),
});

cassandraClient
  .connect()
  .then(() => logger.info(`✅ Conectado ao Cassandra com sucesso.`))
  .catch((err) => {
    console.error('❌ Erro ao conectar ao Cassandra:', err.message);
    process.exit(1);
  });

app.use(bodyParser.json());

async function sendWhatsappMessage(number, instance, text) {
  logger.info(`📨 Enviando mensagem para ${number}: "${text}"`);
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
  const response = await axios({
    method: 'POST',
    url: `${process.env.API_BASE_URL}/${keyspace}/speech/from-text`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
  const query = `SELECT settings FROM environments WHERE name = ? ALLOW FILTERING`;
  const result = await cassandraClient.execute(query, [environmentName], {
    prepare: true,
  });

  if (result.rows.length === 0) {
    throw new Error(`Nenhum environment encontrado para ${environmentName}`);
  }

  const rawSettings = result.rows[0].settings;

  logger.info(`🧪 Conteúdo de settings:`, rawSettings);

  let parsedSettings;
  if (typeof rawSettings === 'string') {
    parsedSettings = JSON.parse(rawSettings.replace(/'/g, '"'));
  } else if (typeof rawSettings === 'object' && rawSettings !== null) {
    parsedSettings = rawSettings;
  } else {
    throw new Error('Formato inesperado em settings do environment');
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

    const evaResponse = await axios({
      method: 'POST',
      url: `${process.env.API_BASE_URL}/${keyspace}/speech/from-audio`,
      headers: {
        Authorization: `Bearer ${token}`,
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

    let payload, template;

    if (isFirstMessage) {
      template = 'template_saudacao';
      payload = {
        memory: JSON.stringify({
          role: 'system',
          content:
            'Você é um representante comercial querendo vender um produto ou uma franquia.',
        }),
        query: message,
        searchdocs: false,
        temperature: 0.9,
        template,
        client_id: clientId,
        sessionid: '',
        username: `WHATSAPP {{${number}}}`,
      };
      logger.info(`👋 Primeira mensagem recebida. Template: ${template}`);
    } else {
      template = 'template_contexto';
      payload = {
        query: message,
        memory: '{}',
        searchdocs: true,
        temperature: '0.2',
        template,
        client_id: clientId,
        email: false,
        zendesk: false,
        sessionid,
        username: `WHATSAPP {{${number}}}`,
        cl: '2',
        engine: 'azure',
      };
      logger.info(`💬 Mensagem de sequência. Template: ${template}`);
    }

    const askUrl = `${process.env.API_BASE_URL}/${keyspace}/ai/ask`;
    logger.info(`📡 Enviando para: ${askUrl}`);
    logger.info(`📦 Payload:`, payload);

    const askResponse = await axios.post(askUrl, payload, {
      headers: { Authorization: `Bearer ${token}` },
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
