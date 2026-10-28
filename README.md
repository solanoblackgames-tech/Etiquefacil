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
BLING_STOCK_DEPOSIT=Geral
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

Com a conta autorizada, o lote passa a ter tambem o botao `Criar produtos no Bling`, que cria pela API apenas os SKUs ainda nao encontrados no Bling. Na tela do pallet/RZ, `Lancar entrada no Bling` procura/cria os produtos necessarios e registra uma entrada de estoque no deposito configurado em `BLING_STOCK_DEPOSIT`, usando a quantidade conferida da RZ.

Os downloads CSV continuam disponiveis como alternativa/manual.

### Autenticacao JWT

A emissao e a renovacao de tokens usam `https://api.bling.com.br/Api/v3/oauth/token`, com `enable-jwt: 1`. As consultas e os envios tambem incluem esse header, junto de `Authorization: Bearer {token}`. Os tokens sao armazenados integralmente, sem limite curto de caracteres (campos `text` no PostgreSQL).

Depois de publicar esta versao, as contas existentes passam a receber JWT na proxima renovacao automatica. Se a autorizacao tiver expirado ou sido revogada, abra Perfil e use **Reconectar no Bling** para autorizar novamente; confira tambem a conta Ecommerce, quando utilizada. Nao e necessario copiar tokens manualmente.

Referencia: [guia oficial de migracao JWT do Bling](https://developer.bling.com.br/migracao-jwt).

## Etiquetas privadas por lote de origem e composicao dos pallets

Na Triagem, abra **Etiquetas por lote de origem**, cadastre uma chegada (por exemplo, **EXP10**) e gere de 1 a 1000 etiquetas por emissao. Na proxima chegada, cadastre **EXP11**; o sistema sugere o proximo codigo numerico, que pode ser ajustado antes do cadastro. Uma origem ja cadastrada pode receber novas emissoes. Os pilotos **A e B** permanecem disponiveis com suas etiquetas e historico originais.

Abra a impressao em papel 60 × 40 mm. Cada etiqueta possui um QR aleatorio exclusivo, sem origem no conteudo impresso. As emissoes anteriores permitem reimprimir os mesmos codigos.

O recurso esta disponivel exclusivamente para a conta Solano Black Games (`solanoblackgames@gmail.com`) e sua equipe. Em **Entradas de lotes**, preencha os dados sem anexar planilha e use **Criar agrupamento por origem**. Esse agrupamento recebe os pallets; EXP10, EXP11 etc. identificam a origem de cada peca. O botao **Criar lote** mantem o fluxo comum, com ou sem lista.

Ao criar um lote por classe, o fornecedor e localizado ou cadastrado no Bling mesmo sem produtos no lote. Se o Bling estiver indisponivel, o lote permanece salvo com o fornecedor pendente. Use **Sincronizar fornecedor no Bling** dentro do lote para tentar novamente ou cadastrar o fornecedor de um lote ja existente.

Em Conferencia, abra o agrupamento, gere/abra um pallet e bipe os QRs privados. A secao **Composicao por lote de origem** mostra quantas pecas de cada origem foram colocadas em cada pallet e no agrupamento inteiro. Tambem permite retirar uma etiqueta antes de coloca-la em outro pallet. Uma etiqueta nao pode pertencer a dois pallets. Lotes da versao anterior que ja possuem historico de classe sao reconhecidos automaticamente, preservando seus registros.

O responsavel pode fechar a composicao: o sistema salva contagens, data e responsavel e bloqueia novas entradas e retiradas de etiquetas nesse pallet. O historico registra cada movimentacao; a composicao pode ser exportada em CSV. Lotes com esse historico nao podem ser excluidos.

Gerar etiquetas nao movimenta estoque. A bipagem privada registra a composicao por classe; o cadastro comercial dos produtos e as movimentacoes no Bling seguem seus fluxos existentes. Os codigos sao consultados somente dentro da conta proprietaria, incluindo seus operadores autorizados.

Com PostgreSQL, os registros ficam na tabela `private_class_state`, criada automaticamente no primeiro uso. No modo local, ficam em `data/private-classes/`, que deve acompanhar o backup de `data/db.json`.

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
