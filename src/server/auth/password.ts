import { hash, verify } from "@node-rs/argon2";

const ARGON2_OPTS = {
  memoryCost: 19456, // 19 MiB (OWASP baseline)
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

export function verifyPassword(hashStr: string, password: string): Promise<boolean> {
  return verify(hashStr, password, ARGON2_OPTS);
}
