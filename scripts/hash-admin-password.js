import bcrypt from "bcryptjs";

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error("Uso: npm run admin:hash -- <senha com pelo menos 10 caracteres>");
  process.exit(1);
}

console.log(`ADMIN_PASSWORD_HASH=${await bcrypt.hash(password, 12)}`);
