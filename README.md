# Etiquefácil

Aplicação web para importar lotes XLSX, gerar SKUs, conferir RZs por bipagem, imprimir etiquetas e exportar CSV do Bling.

## Rodar localmente

```bash
npm install
npm start
```

Abra `http://localhost:3000`.

Sem `DATABASE_URL`, o app usa `data/db.json` e salva CSVs na pasta Downloads do Windows.

## Variáveis de produção

Copie `.env.example` e configure no provedor:

```bash
DATABASE_URL=postgres://...
SESSION_SECRET=uma-chave-grande
NODE_ENV=production
DOWNLOAD_MODE=browser
```

Com `DATABASE_URL`, o app cria automaticamente as tabelas PostgreSQL ao iniciar.

## Migrar dados locais para PostgreSQL

Com `DATABASE_URL` definido:

```bash
npm run migrate:json-to-postgres
```

Por padrão, migra `data/db.json`. Também é possível informar outro caminho:

```bash
npm run migrate:json-to-postgres -- C:\caminho\db.json
```

## Deploy sugerido

1. Subir este projeto para GitHub.
2. Criar um PostgreSQL no Render, Railway ou provedor equivalente.
3. Criar um serviço Node.js apontando para o repositório.
4. Configurar as variáveis de ambiente acima.
5. Build command: `npm install`.
6. Start command: `npm start`.
