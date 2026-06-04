import pino from "pino";
import { config } from "./config.js";

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.password_hash",
      "*.secret",
      "*.encrypted_secret",
      "*.iv",
      "*.auth_tag",
      "*.token",
      "*.GEMINI_API_KEY",
    ],
    remove: true,
  },
});
