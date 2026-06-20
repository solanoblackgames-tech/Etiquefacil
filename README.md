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
SESSION_SECRET=uma-chave-grande-com-32-caracteres-ou-mais
NODE_ENV=production
DOWNLOAD_MODE=browser
BLING_CLIENT_ID=client-id-do-app-bling
BLING_CLIENT_SECRET=client-secret-do-app-bling
BLING_REDIRECT_URI=https://seu-dominio.com/api/integrations/bling/callback
```

Com `DATABASE_URL`, o app cria automaticamente as tabelas PostgreSQL ao iniciar. Em produção, `DATABASE_URL` e `SESSION_SECRET` são obrigatórios.

O banco remoto atual não aceita SSL, então configure também:

```bash
PGSSL=false
```

Se trocar para um provedor com SSL gerenciado, remova `PGSSL=false`.

## Integracao Bling API

Cadastre o aplicativo no Bling e configure o Link de redirecionamento como:

```text
https://seu-dominio.com/api/integrations/bling/callback
```

Para teste local, use:

```text
http://localhost:3000/api/integrations/bling/callback
```

Depois configure `BLING_CLIENT_ID`, `BLING_CLIENT_SECRET` e `BLING_REDIRECT_URI` no servidor. Cada usuario autoriza a propria conta Bling pela aba Perfil; ele nao precisa preencher client secret nem tokens.

## Health check

Use o endpoint abaixo no provedor:

```bash
GET /healthz
```

Resposta esperada com PostgreSQL ativo:

```json
{"ok":true,"storage":"postgres"}
```

## Migrar dados locais para PostgreSQL

Com `DATABASE_URL` definido:

```bash
npm run migrate:json-to-postgres
```

Por padrão, migra `data/db.json`. Também é possível informar outro caminho:

```bash
npm run migrate:json-to-postgres -- C:\caminho\db.json
```

Para este ambiente:

```bash
npm run migrate:json-to-postgres -- /Users/caio/Downloads/db.json
```

Valide as contagens após a migração:

```text
users=8
lots=11
products=13418
rz_items=14904
scans=7
labels=1
```

## Importar base oculta de produtos

A base oculta e usada na criacao de remessas dentro de lotes diversos quando o Codigo ML nao existe nos lotes normais.

```bash
npm run import:catalog -- C:\caminho\base-oculta.xlsx
```

Colunas aceitas: `Marca` ou `Codigo ML` para o codigo bipado, `Descricao`, `Preco`, `Preco de custo`, `Categoria` e `Subcategoria`.
Ao importar, a base oculta anterior e substituida.

## Deploy sugerido

1. Subir este projeto para GitHub.
2. Criar um PostgreSQL no Render, Railway ou provedor equivalente.
3. Criar um serviço Node.js apontando para o repositório.
4. Configurar as variáveis de ambiente acima.
5. Build command: `npm ci`.
6. Start command: `npm start`.
7. Health check path: `/healthz`.

Após validar em produção, rotacione a senha do PostgreSQL se a URL do banco tiver sido compartilhada.
