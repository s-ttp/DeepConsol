import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { UserRole } from "@deepconsol/shared";

export interface SessionClaims {
  sub: string;
  email: string;
  role: UserRole;
  must_rotate: boolean;
}

export function signSession(claims: SessionClaims): string {
  return jwt.sign(claims, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: `${config.jwtTtlHours}h`,
  });
}

export function verifySession(token: string): SessionClaims {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] });
  if (typeof decoded === "string") throw new Error("invalid token");
  return decoded as unknown as SessionClaims;
}
