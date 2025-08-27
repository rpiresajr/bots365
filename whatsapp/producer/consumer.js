const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");
const logger = require("../consumer/logger");
require("dotenv").config();

const app = express().use(body_parser.json());
const sessions = new Map();
const SESSION_TIMEOUT = process.env.SESSION_TIMEOUT
  ? Number(process.env.SESSION_TIMEOUT)
  : 10 * 60 * 1000;

const TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN;
const WHATSAPP_API_VERSION = "v16.0";
const WHATSAPP_API_URL = "https://graph.facebook.com";
const EVA_BOT_TEMPERATURE = Number(process.env.EVA_BOT_TEMPERATURE) || 0.2;
const EVA_BOT_SEARCH_DOCS = process.env.EVA_BOT_SEARCH_DOCS || "true";
const EVA_BOT_ENGINE = process.env.EVA_BOT_ENGINE || "azure";
const EVA_BOT_CL = process.env.EVA_BOT_CL || "1";
const EVA_EXPIRED_SESSION_MESSAGE = process.env.EVA_EXPIRED_SESSION_MESSAGE;
const EVA_GREETING_MESSAGE =
  process.env.EVA_GREETING_MESSAGE ||
  "Se apresente de maneira informal para o usuário falando sobre é um assistente virtual especializado da empresa e irá ajudá-lo";
let evaBearerToken = "";
const EVA_REPLY_AUDIO_TYPE = process.env.EVA_REPLY_AUDIO_TYPE || "audio";
const APP_PORT = Number(process.env.PORT || 8080);

const verifyWebhook = (req, res) => {
  const mode = req.query["hub.mode"];
  const challenge = req.query["hub.challenge"];
  const token = req.query["hub.verify_token"];

  if (!mode || !token) {
    return res.sendStatus(403);
  }

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
};

const proccessSession = (phoneNumberId, from) => {
  const now = Date.now();
  const existingSession = sessions.get(phoneNumberId);

  if (
    existingSession &&
    now - existingSession.lastInteraction < SESSION_TIMEOUT
  ) {
    existingSession.lastInteraction = now;
    return existingSession;
  }

  const newSession = {
    lastInteraction: now,
    from,
  };
  sessions.set(phoneNumberId, newSession);
  return newSession;
};

const handleIncomingMessage = async (req, res) => {
  const bodyParam = req.body;
  try {
    if (!isValidWhatsAppMessage(bodyParam)) {
      return res.sendStatus(404);
    }

    const messageData = extractMessageData(bodyParam);
    sendWhatsAppReply(messageData);

    return res.sendStatus(200);
  } catch (error) {
    logger.error("Error processing webhook:", error);
    return res.sendStatus(500).json({ message: error.message });
  }
};

async function getEvaToken() {
  if (evaBearerToken) {
    return evaBearerToken;
  }
  const requestLogin = await axios.post(`${process.env.EVA_HOST}/api/login`, {
    client_id: process.env.EVA_CLIENT_ID,
    password: process.env.EVA_PASSWORD,
  });
  if (requestLogin?.data?.message) {
    evaBearerToken = requestLogin.data.message;
  }
  return evaBearerToken;
}

async function sendEvaRequest({
  textMessage,
  phoneNumberId,
  from,
  replyType = "text",
} = {}) {
  try {
    let sessionData = sessions.get(phoneNumberId);

    const token = await getEvaToken();

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    };

    const requestBody = {
      memory: "{}",
      searchdocs: EVA_BOT_SEARCH_DOCS,
      temperature: EVA_BOT_TEMPERATURE,
      template: sessionData.evaSession
        ? "template_contexto"
        : "template_saudacao",
      ...(sessionData.evaSession && {
        sessionid: sessionData.evaSession,
        query: textMessage,
      }),
      ...(!sessionData.evaSession && {
        query: EVA_GREETING_MESSAGE,
      }),
      client_id: process.env.EVA_CLIENT_ID,
      email: false,
      zendesk: false,
      username: `WHATSAPP - ${phoneNumberId} - ${process.env.EVA_CLIENT_ID}`,
      cl: EVA_BOT_CL,
      engine: EVA_BOT_ENGINE,
    };

    logger.info("EVA Request Payload:", JSON.stringify(requestBody, null, 2));

    const response = await axios.post(
      `${process.env.EVA_HOST}/api/ai/ask`,
      requestBody,
      { headers }
    );

    logger.info("EVA Response:", JSON.stringify(response.data, null, 2));

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
      await sendTextMessage(phoneNumberId, from, response.data.message);
    } else if (replyType === "audio") {
      const file = await getFileFromText(response.data.message);
      await sendAudioMessage(phoneNumberId, from, file);
    }
    if (requestBody.template === "template_saudacao") {
      await sendEvaRequest({ phoneNumberId, from, textMessage, replyType });
    }
  } catch (error) {
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaBearerToken = null;
      return sendEvaRequest({ textMessage, phoneNumberId, from, replyType });
    }
    logger.error(error);
  }
}

const isValidWhatsAppMessage = (payload) => {
  return (
    payload.object && payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  );
};

const extractMessageData = (payload) => {
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
  const { messageBody, phoneNumberId, from } = params;

  await sendEvaRequest({
    textMessage: messageBody,
    phoneNumberId,
    from,
  });
};

const handleAudioMessage = async (params) => {
  const { phoneNumberId, from } = params;
  const { audio } = params;
  try {
    if (!audio || !audio.id) {
      logger.error("Sorry, I couldn't process this audio message.");
      return;
    }
    const audioMessage = await getAudioMessage(audio.id);
    if (audioMessage) {
      await sendEvaRequest({
        textMessage: audioMessage,
        phoneNumberId,
        from,
        replyType: EVA_REPLY_AUDIO_TYPE,
      });
    }
  } catch (error) {
    logger.error(error, "Error handling audio message:");
  }
};

const getAudioMessage = async (mediaId) => {
  let fileName = null;
  try {
    const response = await axios({
      method: "GET",
      url: `${WHATSAPP_API_URL}/${WHATSAPP_API_VERSION}/${mediaId}`,
      params: { access_token: TOKEN },
    });

    const audioResponse = await axios({
      method: "GET",
      url: response.data.url,
      responseType: "arraybuffer",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    fileName = `${mediaId}.mp3`;
    fs.writeFileSync(fileName, audioResponse.data);
    logger.info(`Audio saved as ${fileName}`);

    const formData = new FormData();
    formData.append("audio", fs.createReadStream(fileName));
    formData.append("language", "pt_BR");

    const token = await getEvaToken();

    const evaResponse = await axios({
      method: "POST",
      url: `${process.env.EVA_HOST}/api/speech/from-audio`,
      headers: {
        Authorization: `Bearer ${token}`,
        ...formData.getHeaders(),
      },
      data: formData,
    });

    return evaResponse?.data?.text;
  } catch (error) {
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaBearerToken = null;
      return getAudioMessage(mediaId);
    }
    logger.error(error, "Error processing audio:");
  } finally {
    if (fileName && fs.existsSync(fileName)) {
      fs.unlinkSync(fileName);
      logger.info(`Cleaned up temporary file: ${fileName}`);
    }
  }
};

const sendWhatsAppReply = async ({
  phoneNumberId,
  from,
  messageType,
  messageBody,
  audio,
}) => {
  try {
    proccessSession(phoneNumberId, from);
    if (messageType === "text") {
      await handleTextMessage({
        phoneNumberId,
        from,
        messageBody,
      });
    } else if (messageType === "audio") {
      await handleAudioMessage({
        phoneNumberId,
        from,
        audio,
      });
    } else {
      logger.error(`Unsupported message type: ${messageType}`);
    }
  } catch (error) {
    logger.error(
      error.response?.data || error.message,
      "Error sending WhatsApp reply: "
    );
  }
};

const sendTextMessage = async (phoneNumberId, from, messageBody) => {
  await axios({
    method: "POST",
    url: `${WHATSAPP_API_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/messages`,
    params: { access_token: TOKEN },
    data: {
      messaging_product: "whatsapp",
      to: from,
      text: { body: messageBody },
    },
    headers: { "Content-Type": "application/json" },
  });
};

const checkExpiredSessions = () => {
  const now = Date.now();
  for (const [phoneNumberId, session] of sessions.entries()) {
    if (now - session.lastInteraction >= SESSION_TIMEOUT) {
      if (EVA_EXPIRED_SESSION_MESSAGE) {
        sendTextMessage(
          phoneNumberId,
          session.from,
          EVA_EXPIRED_SESSION_MESSAGE
        )
          .then(() => {
            sessions.delete(phoneNumberId);
            logger.info(`Session expired and removed for ${phoneNumberId}`);
          })
          .catch((error) => {
            logger.error(
              error,
              `Error sending goodbye message to ${phoneNumberId}:`
            );
          });
      }
    }
  }
};

async function getFileFromText(text, language = "pt") {
  try {
    const token = await getEvaToken();

    const response = await axios({
      method: "POST",
      url: `${process.env.EVA_HOST}/api/speech/from-text`,
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

    return response.data;
  } catch (error) {
    if (
      error?.response?.data?.message === "Token expirado ou não autorizado!"
    ) {
      evaBearerToken = null;
      return getFileFromText(text, language);
    }
    logger.error(error, "Error generating speech from text");
    return null;
  }
}

async function sendAudioMessage(phoneNumberId, to, buffer) {
  try {
    // Create a temporary file name with timestamp to avoid conflicts
    const tempFileName = `temp_audio_${Date.now()}.mp3`;

    // Write the buffer to a temporary file
    fs.writeFileSync(tempFileName, buffer);

    // Create form data for the file upload
    const formData = new FormData();
    formData.append("file", fs.createReadStream(tempFileName));
    formData.append("messaging_product", "whatsapp");
    formData.append("type", "audio/mpeg");

    // Upload the audio file
    const uploadResponse = await axios({
      method: "POST",
      url: `${WHATSAPP_API_URL}/${WHATSAPP_API_VERSION}/${phoneNumberId}/media`,
      params: { access_token: TOKEN },
      headers: {
        ...formData.getHeaders(),
      },
      data: formData,
    });

    const mediaId = uploadResponse.data.id;

    // Send the audio message using the uploaded media ID
    await axios({
      method: "POST",
      url: `${WHATSAPP_API_URL}/v17.0/${phoneNumberId}/messages`,
      params: { access_token: TOKEN },
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
    fs.unlinkSync(tempFileName);
  } catch (error) {
    logger.error(
      error.response?.data || error.message,
      "Error sending audio message:"
    );
  }
}

logger.info("Application started");

setInterval(checkExpiredSessions, 30 * 1000);

app.get("/webhook", verifyWebhook);
app.post("/webhook", handleIncomingMessage);

app.get("/", (req, res) => {
  logger.info("hello this is webhook setup");
  res.status(200).send("hello this is webhook setup");
});

app.listen(APP_PORT, () => {
  logger.info(`Application is running on port ${process.env.PORT}`, {
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
    WHATSAPP_WEBHOOK_TOKEN: process.env.WHATSAPP_WEBHOOK_TOKEN,
    PORT: process.env.PORT,
    EVA_CLIENT_ID: process.env.EVA_CLIENT_ID,
    EVA_PASSWORD: process.env.EVA_PASSWORD,
    EVA_HOST: process.env.EVA_HOST,
    EVA_BOT_TEMPERATURE: process.env.EVA_BOT_TEMPERATURE,
    EVA_BOT_SEARCH_DOCS: process.env.EVA_BOT_SEARCH_DOCS,
    EVA_BOT_ENGINE: process.env.EVA_BOT_ENGINE,
    EVA_BOT_CL: process.env.EVA_BOT_CL,
    EVA_EXPIRED_SESSION_MESSAGE: process.env.EVA_EXPIRED_SESSION_MESSAGE,
    EVA_GREETING_MESSAGE: process.env.EVA_GREETING_MESSAGE,
    EVA_REPLY_AUDIO_TYPE: process.env.EVA_REPLY_AUDIO_TYPE,
  });
});
