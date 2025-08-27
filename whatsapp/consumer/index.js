const { Consumer } = require("sqs-consumer");
const { SQSClient } = require("@aws-sdk/client-sqs");
const dotenv = require("dotenv");
const { handleMessage } = require("./whatsappService");
dotenv.config();
const logger = require("./logger");
const { default: axios } = require("axios");
const { EVA_URL, EVA_API_KEY } = process.env;

logger.info(
  `Starting consumer ${JSON.stringify(
    {
      EVA_URL: process.env.EVA_URL,
      EVA_API_KEY: process.env.EVA_API_KEY,
      PORT: process.env.PORT,
    },
    null,
    2
  )} `
);

if (!EVA_URL || !EVA_API_KEY) {
  throw new Error("EVA_URL and EVA_API_KEY must be set");
}

let cachedEvaConfig = null;

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
    logger.error(error, "[getEvaConfig] Error fetching Eva config");
    throw new Error("Error fetching Eva config");
  }
}

async function processMessage(message) {
  try {
    logger.info(`[processMessage] Processing messageID: ${message.MessageId}`);
    const body = JSON.parse(message.Body);
    const { event } = body;
    const botConfig = {
      ...body.botConfig,
      messageId: message.MessageId,
    };

    await handleMessage(event, botConfig);
  } catch (error) {
    logger.error(error, "[processMessage] Error processing message:");
  }
}

function createConsumer(sqsConfig) {
  const sqsClient = new SQSClient({
    region: sqsConfig.region,
    credentials: {
      accessKeyId: sqsConfig.accessKeyId,
      secretAccessKey: sqsConfig.secretAccessKey,
    },
  });

  const consumer = Consumer.create({
    queueUrl: sqsConfig.queueUrl,
    handleMessage: processMessage,
    sqs: sqsClient,
    handleMessageTimeout: 1000 * 150,
    batchSize: sqsConfig.batchSize || 5,
    waitTimeSeconds: 0,
    visibilityTimeout: 180
  });

  consumer.on("error", (err) => {
    logger.error(err, "Consumer error:");
  });

  consumer.on("processing_error", (err) => {
    logger.error(err, "Processing error:");
  });

  consumer.on("timeout_error", (err) => {
    logger.error(err, "Timeout error:");
  });

  return consumer;
}

async function main() {
  const evaConfig = await getEvaConfig();
  const sqsConfigMap = new Map(
    Object.values(evaConfig).map((config) => [config.sqs.url, config.sqs])
  );

  const consumers = [];

  // Create a consumer for each unique SQS key
  for (const [url, sqs] of sqsConfigMap) {
    const sqsConfig = {
      queueUrl: url,
      accessKeyId: sqs.accessKeyId,
      secretAccessKey: sqs.secretAccessKey,
      region: sqs.region,
    };
    if (
      !sqsConfig.queueUrl ||
      !sqsConfig.accessKeyId ||
      !sqsConfig.secretAccessKey
    ) {
      logger.error(`Invalid SQS configuration for key: ${url}`);
      continue;
    }
    logger.info(`Consumer for key: ${url} starting...`);
    const consumer = createConsumer(sqsConfig);

    consumer.start();
    logger.info(`Consumer for key: ${url} started!`);
    consumers.push(consumer);
  }

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info("Performing graceful shutdown...");
    Promise.all(consumers.map((consumer) => consumer.stop()))
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error(err, "Error during shutdown:");
        process.exit(1);
      });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

setInterval(async () => {
  logger.info("Deleting eva config cache");
  cachedEvaConfig = null;
}, 1000 * 60 * 10);

main().catch((error) => {
  logger.error(error, "Fatal error");
  process.exit(1);
});
