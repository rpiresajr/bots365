const express = require("express");
const body_parser = require("body-parser");
require("dotenv").config();
const AWS = require("aws-sdk");
const app = express().use(body_parser.json());
const APP_PORT = Number(process.env.PORT || 8080);
const { default: axios } = require("axios");
const logger = require("./logger");

logger.info(
  `Starting producer ${JSON.stringify(
    {
      EVA_URL: process.env.EVA_URL,
      EVA_API_KEY: process.env.EVA_API_KEY,
      WHATSAPP_WEBHOOK_TOKEN: process.env.WHATSAPP_WEBHOOK_TOKEN,
      PORT: process.env.PORT,
    },
    null,
    2
  )} `
);

const { EVA_URL, EVA_API_KEY } = process.env;
const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN;

let cachedEvaConfig = null;

if (!EVA_URL || !EVA_API_KEY) {
  throw new Error("EVA_URL and EVA_API_KEY must be set");
}

async function getEvaConfig() {
  try {
    if (cachedEvaConfig) {
      return cachedEvaConfig;
    }
    const response = await axios.get(`${EVA_URL}`, {
      headers: {
        "api-key": EVA_API_KEY,
      },
    });
    cachedEvaConfig = response.data;
    return response.data;
  } catch (error) {
    throw new Error("Error fetching Eva config");
  }
}

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

const isInWhiteList = (whiteList, numberFrom) => {
  if (!whiteList.length) {
    return true;
  }
  return whiteList.includes(numberFrom);
};

const isInBlackList = (blackList, numberFrom) => {
  if (!blackList.length) {
    return false;
  }
  return blackList.includes(String(numberFrom));
};

const handleIncomingMessage = async (req, res) => {
  const bodyParam = req.body;
  try {
    if (!isValidWhatsAppMessage(bodyParam)) {
      return res.sendStatus(404);
    }

    const phoneNumberId =
      bodyParam.entry[0].changes[0].value.metadata.phone_number_id;
    const from = bodyParam.entry[0].changes[0].value.messages[0].from;
    const entryId = new Date().getTime();

    const evaConfig = await getEvaConfig();

    const numberConfig = evaConfig;

    if (!numberConfig) {
      return res.sendStatus(404);
    }
    const sqsConfig = numberConfig?.[phoneNumberId]?.sqs;
    if (
      !sqsConfig.url ||
      !sqsConfig.accessKeyId ||
      !sqsConfig.secretAccessKey
    ) {
      return res.sendStatus(404);
    }

    const sqs = new AWS.SQS({
      accessKeyId: sqsConfig.accessKeyId,
      secretAccessKey: sqsConfig.secretAccessKey,
      region: sqsConfig.region,
    });

    const messageParams = {
      MessageBody: JSON.stringify({
        event: bodyParam,
        botConfig: numberConfig?.[phoneNumberId],
      }),
      QueueUrl: sqsConfig.url,
      MessageGroupId: `${phoneNumberId}-${from}`,
      MessageDeduplicationId: `${phoneNumberId}-${from}-${entryId}}`,
    };
    const numberFrom =
      bodyParam?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;

    const whiteList = numberConfig?.[phoneNumberId]?.whatsapp?.whiteList || [];
    const blackList = numberConfig?.[phoneNumberId]?.whatsapp?.blackList || [];

    if (!isInWhiteList(whiteList, numberFrom)) {
      logger.info(
        `Message skipped because is not in the white list: ${numberFrom}`
      );
      return res.sendStatus(200);
    }

    if (isInBlackList(blackList, numberFrom)) {
      logger.info(`Message skipped because is in black list: ${numberFrom}`);
      return res.sendStatus(200);
    }

    const sqsResponse = await sqs.sendMessage(messageParams).promise();
    logger.info(
      `Message created as ${JSON.stringify({
        ...sqsResponse,
        MessageDeduplicationId: messageParams.MessageDeduplicationId,
      })}`
    );
    return res.sendStatus(200);
  } catch (error) {
    logger.error(error, "Error processing webhook");
    return res.status(500).json({ message: error.message });
  }
};

const isValidWhatsAppMessage = (payload) => {
  return (
    payload.object && payload.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
  );
};

app.get("/webhook", verifyWebhook);
app.post("/webhook", handleIncomingMessage);

app.get("/", (req, res) => {
  logger.info("hello this is webhook setup");
  res.status(200).send("hello this is webhook setup");
});

setInterval(async () => {
  logger.info("Deleting eva config cache");
  cachedEvaConfig = null;
}, 1000 * 60 * 10);

app.listen(APP_PORT, async () => {
  await getEvaConfig();
  logger.info(`Bot producer running on port ${process.env.PORT}`);
});
