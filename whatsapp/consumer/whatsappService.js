const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
require("dotenv").config();

const sessions = new Map();
const evaClientTokens = new Map();
const logger = require("./logger");

const handleMessage = async (whatsappMessage, botConfig) => {
  try {
    logger.info(
      `[handleMessage messageId:${botConfig.messageId}] Handling message`
    );
    const messageData = extractMessageData(whatsappMessage);
    logger.info(
      `[handleMessage messageId:${
        botConfig.messageId
      }] Message data: ${JSON.stringify(messageData, null, 2)}`
    );
    await sendWhatsAppReply(messageData, {
      botConfig,
    });
  } catch (error) {
    logger.error(
      error,
      `[handleMessage messageId:${botConfig.messageId}] Error handling message:`
    );
  }
};

const proccessSession = (phoneNumberId, from, botConfig) => {
  logger.info(
    `[proccessSession messageId:${botConfig.messageId}] Processing session for ${phoneNumberId}`
  );
  const now = Date.now();
  const existingSession = sessions.get(phoneNumberId);
  const SESSION_TIMEOUT = botConfig.bot.sessionTimeout
    ? Number(botConfig.bot.sessionTimeout)
    : 10 * 60 * 1000;

  if (
    existingSession &&
    now - existingSession.lastInteraction < SESSION_TIMEOUT
  ) {
    logger.info(
      `[proccessSession messageId:${botConfig.messageId}] Session already exists for ${phoneNumberId}`
    );
    existingSession.lastInteraction = now;
    return existingSession;
  }

  const newSession = {
    lastInteraction: now,
    from,
    botConfig,
  };
  sessions.set(phoneNumberId, newSession);
  logger.info(
    `[proccessSession messageId:${botConfig.messageId}] Session created for ${phoneNumberId}`
  );
  return newSession;
};

async function getEvaToken(config = {}) {
  logger.info(
    `[getEvaToken messageId:${config.messageId}] Getting Eva token for ${config.auth.client_id}`
  );
  const { client_id, password, host } = config.auth;
  const token = evaClientTokens.get(client_id);
  if (token) {
    logger.info(
      `[getEvaToken messageId:${config.messageId}] Token already exists for ${config.auth.client_id}`
    );
    return token;
  }
  const requestLogin = await axios.post(`${host}/api/login`, {
    client_id: client_id,
    password: password,
  });
  if (requestLogin?.data?.message) {
    evaClientTokens.set(client_id, requestLogin.data.message);
    logger.info(
      `[getEvaToken messageId:${config.messageId}] Token set for ${config.auth.client_id}`
    );
  }
  return requestLogin.data.message;
}

async function sendEvaRequest({
  textMessage,
  phoneNumberId,
  from,
  replyType = "text",
  botConfig,
} = {}) {
  try {
    logger.info(
      `[sendEvaRequest messageId:${botConfig.messageId}] Sending EVA request for ${phoneNumberId}`
    );
    let sessionData = sessions.get(phoneNumberId);

    const token = await getEvaToken(botConfig);

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const requestBody = {
      memory: "{}",
      searchdocs: botConfig.bot.searchDocs,
      temperature: botConfig.bot.temperature,
      template: sessionData.evaSession
        ? "template_contexto"
        : "template_saudacao",
      ...(sessionData.evaSession && {
        sessionid: sessionData.evaSession,
        query: textMessage,
      }),
      ...(!sessionData.evaSession && {
        query: botConfig.bot.greetingMessage,
      }),
      client_id: botConfig.auth.client_id,
      email: false,
      zendesk: false,
      username: `WHATSAPP - ${phoneNumberId} - ${botConfig.auth.client_id}`,
      cl: botConfig.bot.cl,
      engine: botConfig.bot.engine,
    };

    logger.info(
      `[sendEvaRequest messageId:${
        botConfig.messageId
      }] EVA Request Payload: ${JSON.stringify(requestBody, null, 2)}`
    );

    const response = await axios.post(
      `${botConfig.auth.host}/api/ai/ask`,
      requestBody,
      { headers }
    );

    logger.info(
      `[sendEvaRequest messageId:${
        botConfig.messageId
      }] EVA Response: ${JSON.stringify(response.data, null, 2)}`
    );

    if (response.data.sessionid) {
      sessionData.evaSession = response.data.sessionid;
      sessions.set(phoneNumberId, {
        ...sessionData,
      });
    }
    sessions.set(phoneNumberId, {
      ...sessionData,
      lastInteraction: Date.now(),
    });
    if (replyType === "text") {
      logger.info(
        `[sendEvaRequest messageId:${botConfig.messageId}] Sending text message to ${from}`
      );
      await sendTextMessage(
        phoneNumberId,
        from,
        response.data.message,
        botConfig
      );
    } else if (replyType === "audio") {
      logger.info(
        `[sendEvaRequest messageId:${botConfig.messageId}] Sending audio message to ${from}`
      );
      const file = await getFileFromText(
        response.data.message,
        "pt",
        botConfig
      );
      await sendAudioMessage(phoneNumberId, from, file, botConfig);
    }
    if (requestBody.template === "template_saudacao") {
      logger.info(
        `[sendEvaRequest messageId:${botConfig.messageId}] Sending text message to ${from}`
      );
      await sendEvaRequest({
        phoneNumberId,
        from,
        textMessage,
        replyType,
        botConfig,
      });
    }
  } catch (error) {
    logger.error(
      error,
      `[sendEvaRequest messageId:${botConfig.messageId}] Error sending Eva request:`
    );
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaClientTokens.delete(botConfig.auth.client_id);
      logger.info(
        `[sendEvaRequest messageId:${botConfig.messageId}] Token deleted for ${botConfig.auth.client_id}`
      );
      return sendEvaRequest({
        textMessage,
        phoneNumberId,
        from,
        replyType,
        botConfig,
      });
    }
    throw error;
  }
}

const extractMessageData = (payload) => {
  logger.info(
    `[extractMessageData Extracting message data`
  );
  const change = payload.entry[0].changes[0].value;
  const message = change.messages[0];

  return {
    phoneNumberId: change.metadata.phone_number_id,
    from: message.from,
    messageType: message.type,
    messageBody: message.text?.body || "",
    audio: message.audio || null,
  };
};

const handleTextMessage = async (params) => {
  const { messageBody, phoneNumberId, from, botConfig } = params;
  logger.info(
    `[handleTextMessage messageId:${botConfig.messageId}] Handling text message`
  );
  await sendEvaRequest({
    textMessage: messageBody,
    phoneNumberId,
    from,
    botConfig,
  });
};

const handleAudioMessage = async (params) => {
  const { phoneNumberId, from, botConfig } = params;
  const { audio } = params;
  logger.info(
    `[handleAudioMessage messageId:${botConfig.messageId}] Handling audio message`
  );
  try {
    if (!audio || !audio.id) {
      logger.error(
        `[handleAudioMessage messageId:${botConfig.messageId}] Sorry, I couldn't process this audio message.`
      );
      return;
    }
    const audioMessage = await getAudioMessage(audio.id, botConfig);
    if (audioMessage) {
      logger.info(
        `[handleAudioMessage messageId:${botConfig.messageId}] Sending audio message to ${from}`
      );
      await sendEvaRequest({
        textMessage: audioMessage,
        phoneNumberId,
        from,
        replyType: botConfig.bot.replyAudioType,
        botConfig,
      });
    }
  } catch (error) {
    logger.error(
      error,
      `[handleAudioMessage messageId:${botConfig.messageId}] Error handling audio message:`
    );
    throw error;
  }
};

const getAudioMessage = async (mediaId, botConfig) => {
  let fileName = null;
  try {
    logger.info(
      `[getAudioMessage messageId:${botConfig.messageId}] Getting audio message from ${mediaId}`
    );
    const response = await axios({
      method: "GET",
      url: `${botConfig.whatsapp.url}/${botConfig.whatsapp.version}/${mediaId}`,
      params: { access_token: botConfig.whatsapp.token },
    });
    logger.info(
      `[getAudioMessage messageId:${
        botConfig.messageId
      }] Audio response: ${JSON.stringify(response.data, null, 2)}`
    );
    const audioResponse = await axios({
      method: "GET",
      url: response.data.url,
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${botConfig.whatsapp.token}`,
      },
    });
    logger.info(
      `[getAudioMessage messageId:${
        botConfig.messageId
      }] Audio response: ${JSON.stringify(audioResponse.data, null, 2)}`
    );

    fileName = `${mediaId}.mp3`;
    fs.writeFileSync(fileName, audioResponse.data);
    logger.info(
      `[getAudioMessage messageId:${botConfig.messageId}] Audio saved as ${fileName}`
    );

    const formData = new FormData();
    formData.append("audio", fs.createReadStream(fileName));
    formData.append("language", "pt_BR");

    const token = await getEvaToken(botConfig);
    logger.info(
      `[getAudioMessage messageId:${botConfig.messageId}] getting eva response from audio`
    );
    const evaResponse = await axios({
      method: "POST",
      url: `${botConfig.auth.host}/api/speech/from-audio`,
      headers: {
        Authorization: `Bearer ${token}`,
        ...formData.getHeaders(),
      },
      data: formData,
    });
    logger.info(
      `[getAudioMessage messageId:${
        botConfig.messageId
      }] Eva response: ${JSON.stringify(evaResponse.data, null, 2)}`
    );

    return evaResponse?.data?.text;
  } catch (error) {
    logger.error(
      error,
      `[getAudioMessage messageId:${botConfig.messageId}] Error getting audio message:`
    );
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaClientTokens.delete(botConfig.auth.client_id);
      return getAudioMessage(mediaId, botConfig);
    }
    logger.error(
      error,
      `[getAudioMessage messageId:${botConfig.messageId}] Error processing audio:`
    );
  } finally {
    if (fileName && fs.existsSync(fileName)) {
      fs.unlinkSync(fileName);
      logger.info(
        `[getAudioMessage messageId:${botConfig.messageId}] Cleaned up temporary file: ${fileName}`
      );
    }
  }
};

const sendWhatsAppReply = async (
  { phoneNumberId, from, messageType, messageBody, audio },
  { botConfig }
) => {
  try {
    logger.info(
      `[sendWhatsAppReply messageId:${botConfig.messageId}] Sending WhatsApp reply`
    );
    proccessSession(phoneNumberId, from, botConfig);
    if (messageType === "text") {
      await handleTextMessage({
        phoneNumberId,
        from,
        messageBody,
        botConfig,
      });
    } else if (messageType === "audio") {
      await handleAudioMessage({
        phoneNumberId,
        from,
        audio,
        botConfig,
      });
    } else {
      logger.error(`Unsupported message type: ${messageType}`);
    }
  } catch (error) {
    logger.error(
      `[sendWhatsAppReply messageId:${
        botConfig.messageId
      }] Error sending WhatsApp reply: ${JSON.stringify({
        error: {
          message: error.message,
          response: error.response?.data,
          stack: error.stack,
          details: error,
        },
      })}`
    );
    await sendTextMessage(
      phoneNumberId,
      from,
      botConfig?.bot?.unexpectedError || "Ocorreu um erro inesperado!",
      botConfig
    );
  }
};

const sendTextMessage = async (phoneNumberId, from, messageBody, botConfig) => {
  logger.info(
    `[sendTextMessage messageId:${botConfig.messageId}] Sending text message to ${from}`
  );
  await axios({
    method: "POST",
    url: `${botConfig.whatsapp.url}/${botConfig.whatsapp.version}/${phoneNumberId}/messages`,
    params: { access_token: botConfig.whatsapp.token },
    data: {
      messaging_product: "whatsapp",
      to: from,
      text: { body: messageBody },
    },
    headers: { "Content-Type": "application/json" },
  });
  logger.info(
    `[sendTextMessage messageId:${botConfig.messageId}] Text message sent successfully`
  );
};

const checkExpiredSessions = () => {
  const now = Date.now();
  for (const [phoneNumberId, session] of sessions.entries()) {
    const SESSION_TIMEOUT = session?.botConfig?.bot?.sessionTimeout
      ? Number(session.botConfig.bot.sessionTimeout)
      : 10 * 60 * 1000;
    if (now - session.lastInteraction >= SESSION_TIMEOUT) {
      if (session?.botConfig?.bot?.expiredSessionMessage) {
        sendTextMessage(
          phoneNumberId,
          session.from,
          session.botConfig.bot.expiredSessionMessage,
          session.botConfig
        )
          .then(() => {
            sessions.delete(phoneNumberId);
            logger.info(
              `[checkExpiredSessions messageId:${session.botConfig.messageId}] Session expired and removed for ${phoneNumberId}`
            );
          })
          .catch((error) => {
            logger.error(
              error,
              `[checkExpiredSessions messageId:${session.botConfig.messageId}] Error sending goodbye message to ${phoneNumberId}:`
            );
          });
      }
    }
  }
};

async function getFileFromText(text, language = "pt", botConfig) {
  try {
    logger.info(
      `[getFileFromText messageId:${botConfig.messageId}] Getting file from text`
    );
    const token = await getEvaToken(botConfig);

    const response = await axios({
      method: "POST",
      url: `${botConfig.auth.host}/api/speech/from-text`,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      data: {
        text,
        language,
      },
      responseType: "arraybuffer",
    });
    logger.info(
      `[getFileFromText messageId:${
        botConfig.messageId
      }] File response: ${JSON.stringify(response.data, null, 2)}`
    );
    return response.data;
  } catch (error) {
    logger.error(
      error,
      `[getFileFromText messageId:${botConfig.messageId}] Error generating speech from text:`
    );
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaClientTokens.delete(botConfig.auth.client_id);
      return getFileFromText(text, language, botConfig);
    }
    logger.error(
      error,
      `[getFileFromText messageId:${botConfig.messageId}] Error generating speech from text:`
    );
    throw error;
  }
}

async function sendAudioMessage(phoneNumberId, to, buffer, botConfig) {
  try {
    logger.info(
      `[sendAudioMessage messageId:${botConfig.messageId}] Sending audio message to ${to}`
    );
    const tempFileName = `temp_audio_${Date.now()}.mp3`;

    logger.info(
      `[sendAudioMessage messageId:${botConfig.messageId}] Saving audio to ${tempFileName}`
    );
    fs.writeFileSync(tempFileName, buffer);

    const formData = new FormData();
    formData.append("file", fs.createReadStream(tempFileName));
    formData.append("messaging_product", "whatsapp");
    formData.append("type", "audio/mpeg");

    logger.info(
      `[sendAudioMessage messageId:${botConfig.messageId}] Uploading audio to WhatsApp`
    );
    const uploadResponse = await axios({
      method: "POST",
      url: `${botConfig.whatsapp.url}/${botConfig.whatsapp.version}/${phoneNumberId}/media`,
      params: { access_token: botConfig.whatsapp.token },
      headers: {
        ...formData.getHeaders(),
      },
      data: formData,
    });

    const mediaId = uploadResponse.data.id;

    logger.info(
      `[sendAudioMessage messageId:${botConfig.messageId}] Sending audio message using media ID ${mediaId}`
    );
    await axios({
      method: "POST",
      url: `${botConfig.whatsapp.url}/${botConfig.whatsapp.version}/${phoneNumberId}/messages`,
      params: { access_token: botConfig.whatsapp.token },
      data: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to,
        type: "audio",
        audio: {
          id: mediaId,
        },
      },
      headers: { "Content-Type": "application/json" },
    });

    logger.info(
      `[sendAudioMessage messageId:${botConfig.messageId}] Audio message sent successfully`
    );
    fs.unlinkSync(tempFileName);
  } catch (error) {
    logger.error(
      error,
      `[sendAudioMessage messageId:${
        botConfig.messageId
      }] Error sending audio message: ${error.response?.data || error.message}`
    );
    throw error;
  }
}

setInterval(checkExpiredSessions, 30 * 1000);

module.exports = {
  handleMessage,
};
