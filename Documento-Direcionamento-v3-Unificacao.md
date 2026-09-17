# Documento de Direcionamento v3: Unificacao Separacao 2.0, Etiquefacil, Lance360, WMS e Bling

## 1. Objetivo

Este documento consolida a arquitetura operacional para unificar os sistemas:

- Separacao 2.0
- Etiquefacil
- Lance360
- Bling
- WMS / fluxo de transferencia e expedicao

A proposta e separar claramente o papel de cada sistema, eliminar duplicidades e criar uma linha unica de operacao: da precificacao ate o destino final do produto, seja venda direta, transferencia, expedicao, devolucao ou leilao.

A logica central fica:

```text
Separacao 2.0 = inteligencia de preco
Etiquefacil = operacao fisica do produto
Lance360 = gestao comercial da leiloaria e eventos
Bling = base oficial de produto, estoque, custo, pedido e margem
WMS = localizacao fisica, movimentacao e expedicao
```

## 2. Principio Mestre

Cada sistema deve ter uma funcao principal e nao deve duplicar a responsabilidade do outro.

| Sistema | Papel principal | Verdade que controla |
|---|---|---|
| Separacao 2.0 | Precificacao | Referencia de preco |
| Etiquefacil | Operacao fisica | Estado fisico e preparacao do produto |
| WMS | Localizacao e movimentacao | Posicao fisica e coleta |
| Lance360 | Gestao comercial da leiloaria | Evento, lote comercial e resultado |
| Bling | Fiscal, estoque e pedido | Produto oficial, custo, estoque, pedido e margem |

Regra principal:

```text
Nenhum sistema deve fingir que tem o produto se o fisico e o estoque oficial nao confirmam isso.
```

## 3. Fluxo Macro

```text
1. Separacao 2.0
   Precifica produtos e gera lista de referencia

2. Etiquefacil
   Importa lista, cria/atualiza produto, gera etiqueta e conduz triagem

3. Bling
   Recebe ou atualiza produto oficial, custo e dados fiscais/comerciais

4. Etiquefacil / WMS
   Produto passa por aceite fisico, posicao, transferencia, lote ou expedicao

5. Lance360
   Recebe lote pronto, organiza evento, acompanha arremate e resultado

6. Bling
   Registra movimentacoes de deposito, pedidos de venda e baixa de estoque
```

## 4. Entidades Principais

Para evitar confusao, a unificacao deve tratar cada entidade de forma separada.

| Entidade | Sistema dono | Descricao |
|---|---|---|
| Produto | Bling | Cadastro oficial do item comercial |
| Item fisico | Etiquefacil / WMS | Unidade ou quantidade fisica manipulada na operacao |
| Etiqueta | Etiquefacil | Identificacao fisica impressa e bipavel |
| Posicao | WMS | Local fisico onde o item esta armazenado |
| Estrutura de transferencia | Etiquefacil / WMS | Agrupamento logistico para mover itens |
| Lote de leilao | Etiquefacil / Lance360 | Agrupamento comercial enviado para evento |
| Evento | Lance360 | Rodada comercial de leilao |
| Deposito | Bling / WMS | Local de estoque oficial e/ou fisico |
| Movimentacao | Bling / WMS | Entrada, saida ou transferencia de estoque |
| Pedido | Bling | Documento comercial/fiscal de venda |
| Comitente | Lance360 | Dono comercial ou origem do lote |

## 5. Cadastro Mestre de Produto

O Bling deve ser o cadastro mestre de produto.

O Etiquefacil pode criar ou atualizar produtos, mas a verdade final de produto deve estar no Bling.

### Dados minimos do produto

| Campo | Dono preferencial | Observacao |
|---|---|---|
| SKU | Bling / Etiquefacil | Deve ser unico |
| Descricao | Bling | Pode nascer da lista importada |
| EAN | Bling | Quando disponivel |
| ASIN | Separacao 2.0 / Etiquefacil | Apoio para precificacao |
| Codigo Mercado Livre | Separacao 2.0 / Etiquefacil | Quando houver |
| Custo | Bling | Base para margem |
| Valor base | Etiquefacil / Lance360 | Usado em lote ou comitente |
| Fotos | Etiquefacil / Lance360 | Separar foto de triagem e foto comercial |
| Deposito | Bling / WMS | Deve refletir posicao real |
| Status operacional | Etiquefacil / WMS | Estado fisico |
| Status comercial | Lance360 / Bling | Evento, venda, pedido |

### Regra

```text
Produto pode existir no Etiquefacil antes do Bling, mas nao pode virar estoque vendavel sem confirmacao do Bling.
```

## 6. Separacao 2.0

O Separacao 2.0 e o ponto inicial quando houver necessidade de precificacao.

### Responsabilidades

- Importar listas ou planilhas de produtos.
- Trabalhar com foco principal em Amazon.
- Buscar preco por ASIN quando disponivel.
- Usar cache/base de precos ja conhecida.
- Buscar por descricao quando ASIN nao resolver.
- Revisar preco no Mercado Livre por descricao quando necessario.
- Gerar lista precificada para seguir ao Etiquefacil.

### Saida esperada

| Campo | Descricao |
|---|---|
| SKU ou identificador | Codigo interno ou referencia |
| ASIN | Quando produto for Amazon |
| EAN | Quando disponivel |
| Codigo ML | Quando houver |
| Descricao | Nome do produto |
| Quantidade | Quantidade disponivel |
| Custo/base | Custo ou valor base conhecido |
| Preco referencia | Preco usado como apoio de decisao |
| Foto/URL | Quando disponivel |
| Origem | Amazon, Mercado Livre, cache, manual etc. |

### Fora do escopo

Separacao 2.0 nao deve:

- Fazer triagem.
- Montar estrutura de transferencia.
- Montar lote de leilao.
- Gerenciar evento.
- Gerar pedido de venda.
- Controlar posicao fisica.

## 7. Etiquefacil

O Etiquefacil passa a ser o centro da operacao fisica do produto.

Ele recebe produtos precificados pelo Separacao 2.0 ou por uma lista modelo ja existente. A partir dai, cuida do cadastro, etiqueta, triagem, foto, laudo, destino e agrupamento.

### Responsabilidades

- Importar lista precificada ou lista modelo.
- Criar ou atualizar produtos.
- Enviar produtos ao Bling.
- Gerar SKU quando necessario.
- Imprimir etiquetas.
- Fazer triagem.
- Registrar laudo, destino, status e foto.
- Definir se produto segue para WMS, transferencia, leilao, expedicao, devolucao ou remontagem.
- Montar agrupamentos fisicos.
- Enviar lotes de leilao prontos ao Lance360.

### Regra

```text
Etiquefacil e dono do preparo fisico, mas nao e dono final do estoque oficial.
```

## 8. WMS

O WMS resolve a localizacao real do produto.

### Responsabilidades

- Entrada por bipagem de etiqueta.
- Bipagem de posicao.
- Validacao de deposito correto.
- Bloqueio de posicao errada.
- Controle de onde o produto esta fisicamente.
- Transferencia entre depositos.
- Fila de expedicao por deposito.
- Rota FIFO.
- Coleta com impressao no corredor.

### Fluxo WMS

```text
Produto triado
   ↓
Destino exige WMS?
   ↓
Bipa etiqueta do produto
   ↓
Bipa posicao
   ↓
Sistema valida deposito/posicao
   ↓
Entrada fisica confirmada
   ↓
Entrada refletida no Bling
   ↓
Produto disponivel conforme deposito e status
```

### Regra critica

```text
Posicao fisica errada deve bloquear venda, transferencia ou expedicao ate correcao.
```

## 9. Bling

O Bling e a base oficial de produto, custo, estoque, pedido e margem.

### Responsabilidades

- Manter cadastro oficial de produtos.
- Manter custo oficial.
- Controlar estoque por deposito.
- Registrar movimentacoes de entrada, saida e transferencia.
- Gerar pedido de venda quando aplicavel.
- Baixar estoque conforme pedido ou movimentacao.
- Permitir analise de margem.

### Integracoes obrigatorias

| Acao | Origem | Destino | Resultado esperado |
|---|---|---|---|
| Criar produto | Etiquefacil | Bling | Produto oficial criado |
| Atualizar produto | Etiquefacil | Bling | Dados sincronizados |
| Aceitar entrada | Etiquefacil / WMS | Bling | Estoque entra no deposito correto |
| Transferir deposito | WMS / Lance360 | Bling | Estoque sai de um deposito e entra em outro |
| Enviar para leilao | Lance360 / Etiquefacil | Bling | Estoque vai para deposito Em leilao |
| Arrematar lote | Lance360 | Bling | Pedido de venda gerado e estoque baixado |
| Devolver lote | Lance360 / Etiquefacil | Bling | Estoque retorna ao deposito correto |

### Falha de integracao

Se o Bling falhar, o sistema de origem deve:

- Guardar a tentativa.
- Marcar status como pendente de sincronizacao.
- Impedir venda quando houver risco de saldo incorreto.
- Permitir reprocessamento manual.
- Registrar erro legivel para operador ou admin.

## 10. Aceite, Estoque e Produto Vendavel

O v2 definia:

```text
Bipagem de aceite = entrada operacional = entrada no Bling = produto vendavel.
```

No v3, a regra fica mais precisa:

```text
Bipagem de aceite = entrada operacional confirmada.
Entrada no Bling = estoque oficial confirmado.
Produto vendavel = estoque oficial confirmado + status permitido + deposito correto.
```

### Produto nao deve ficar vendavel quando

- Ainda nao foi aceito fisicamente.
- Nao sincronizou com Bling.
- Esta em triagem pendente.
- Esta bloqueado.
- Esta em posicao errada.
- Esta em estrutura de transferencia aberta.
- Esta em lote de leilao.
- Esta no deposito Em leilao.
- Esta em expedicao.
- Esta avariado, em RMA ou devolucao.

## 11. Status e Dono de Status

### Produto / Item fisico

| Status | Significado | Dono |
|---|---|---|
| Cadastrado | Produto importado/criado | Etiquefacil / Bling |
| Triagem pendente | Ainda precisa passar por triagem | Etiquefacil |
| Triado | Ja tem laudo/destino | Etiquefacil |
| Com foto de triagem | Possui evidencia visual | Etiquefacil |
| Aceite pendente | Ainda nao entrou operacionalmente | Etiquefacil / WMS |
| Aceito | Bipagem confirmou entrada fisica | Etiquefacil / WMS |
| Vendavel | Estoque disponivel no deposito correto | Bling + regra operacional |
| Bloqueado | Nao pode vender/mover | Etiquefacil / WMS / Bling |
| Em transferencia | Vinculado a estrutura de transferencia | Etiquefacil / WMS |
| Em leilao | Vinculado a lote/evento | Lance360 / Bling |
| Em expedicao | Separado para saida | WMS / Bling |
| Avariado/RMA | Precisa de tratativa | Etiquefacil |

### Estrutura de transferencia

| Status | Significado | Dono |
|---|---|---|
| Aberta | Recebendo itens | Etiquefacil |
| Fechada | Agrupamento concluido | Etiquefacil |
| Em movimentacao | Saindo de um local para outro | WMS |
| Recebida | Aceita no destino | WMS / Etiquefacil |
| Divergente | Problema de quantidade/local | WMS / Etiquefacil |
| Finalizada | Processo encerrado | Etiquefacil / WMS |

### Lote de leilao

| Status | Significado | Dono |
|---|---|---|
| Em montagem | Ainda sendo montado no Etiquefacil | Etiquefacil |
| Pronto para envio | Pode ir ao Lance360 | Etiquefacil |
| Recebido no Lance360 | Ja entrou na gestao da leiloaria | Lance360 |
| Pronto para evento | Disponivel para vincular a evento | Lance360 |
| Em evento | Participando de evento | Lance360 |
| Arrematado | Vendido | Lance360 |
| Nao arrematado | Nao vendido | Lance360 |
| Disponivel para novo evento | Pode ser reaproveitado | Lance360 |
| Devolvido | Saiu da gestao da leiloaria e volta ao Etiquefacil | Lance360 / Etiquefacil |
| Finalizado | Processo encerrado | Lance360 |

### Evento

| Status | Significado | Dono |
|---|---|---|
| Planejado | Criado em preparacao | Lance360 |
| Aberto | Recebendo lotes | Lance360 |
| Enviado | Catalogo/planilha enviado | Lance360 |
| Em andamento | Evento ativo | Lance360 |
| Realizado | Evento aconteceu | Lance360 |
| Fechado | Todos os lotes classificados | Lance360 |
| Conciliado | Pedidos, estoque e resultados conferidos | Lance360 / Bling |

## 12. Foto de Triagem vs Foto Comercial

A foto pode nascer no Etiquefacil durante a triagem, mas ela nao deve ser tratada sempre como foto comercial.

| Tipo de foto | Funcao | Dono |
|---|---|---|
| Foto da triagem | Evidencia, diagnostico e registro operacional | Etiquefacil |
| Foto comercial | Imagem usada para venda, leilao ou catalogo | Lance360 / Etiquefacil |

### Regras

- Se a foto da triagem estiver boa, pode ser aproveitada como comercial.
- Se precisar melhorar, pode ser trocada ou complementada.
- O Lance360 pode alterar/adicionar foto comercial quando necessario.
- A foto original da triagem deve permanecer como historico/evidencia.

## 13. Estrutura de Transferencia

O termo bag deve ser substituido operacionalmente por:

```text
Estrutura de transferencia
```

O conceito original da bag do Separacao deve ser preservado:

```text
Estrutura de transferencia = agrupamento fisico/logistico de itens bipados.
```

### Serve para

- Agrupar produtos bipados.
- Separar fisicamente itens.
- Controlar quantidade.
- Gerar codigo proprio.
- Imprimir etiqueta.
- Transferir entre areas, depositos ou destinos.
- Registrar divergencia.
- Nao exigir foto obrigatoria.

### Regra

```text
Item dentro de estrutura de transferencia aberta nao deve ficar disponivel para venda.
```

## 14. Lote de Leilao

O lote de leilao nasce no Etiquefacil e passa para o Lance360 quando estiver pronto comercialmente.

### Regra de identidade

```text
Lote de leilao tem codigo proprio, mas mantem vinculo item a item com os SKUs originais.
```

Isso e necessario para:

- Calcular margem por produto.
- Gerar pedido detalhado no Bling.
- Baixar estoque corretamente.
- Reaproveitar lote.
- Dissolver lote.
- Remontar novos lotes.
- Manter historico comercial.

### Base comum entre transferencia e lote

```text
Criar agrupamento
   ↓
Bipar produtos
   ↓
Controlar quantidades
   ↓
Imprimir etiqueta
   ↓
Fechar agrupamento
```

### Diferenca

| Estrutura de transferencia | Lote de leilao |
|---|---|
| Uso interno/logistico | Uso comercial/leiloaria |
| Nao exige foto | Pode exigir foto comercial |
| Move produto entre areas | Envia lote para evento |
| Fecha como agrupamento operacional | Fecha como lote pronto para leilao |

## 15. Lance360

O Lance360 deixa de ser o sistema principal de loteamento fisico.

Ele passa a ser a gestao comercial da leiloaria.

### Responsabilidades

- Receber lotes de leilao prontos vindos do Etiquefacil.
- Organizar lotes por evento.
- Definir lance minimo no evento.
- Controlar status comercial dos lotes.
- Exportar planilha do evento.
- Acompanhar comitentes externos.
- Gerar pedido de venda no Bling quando aplicavel.
- Controlar resultado da leiloaria.
- Permitir reaproveitamento ou devolucao de lotes.

### Fora do escopo

Lance360 nao deve:

- Criar produto no Bling como fluxo principal.
- Fazer precificacao inicial.
- Ser o ponto principal de triagem.
- Duplicar cadastro do Etiquefacil.
- Ser o local principal de montagem fisica do lote.

## 16. Evento no Lance360

Um evento e uma rodada comercial de leilao.

```text
Evento Setembro
  Lote 1
  Lote 2
  Lote 3
```

### Campos do evento

| Campo | Funcao |
|---|---|
| Nome do evento | Identificacao comercial |
| Data | Quando ocorrera |
| Comitente/leiloaria | Origem/destino comercial |
| Percentual da leiloaria | Exemplo: 51% |
| Lance minimo | Piso comercial definido pelo admin |
| Deposito de evento | Exemplo: Em leilao |
| Regras de retorno | O que acontece com nao arrematados |
| Tipo de comitente | Interno ou externo |
| Gera pedido no Bling | Sim, nao ou configuravel |

### Quatro numeros obrigatorios

O Lance360 precisa mostrar no evento:

| Numero | Onde nasce | Para que serve |
|---|---|---|
| Custo do produto | Bling | Diz se da margem |
| Valor base do comitente | Contrato/envio do lote | Quanto o dono quer receber |
| Valor de entrada da leiloaria | Valor base x percentual | Valor do pedido para a leiloaria |
| Lance minimo | Admin/evento | Piso do leilao |

### Indicadores recomendados

- Custo total do lote.
- Valor base total do comitente.
- Valor de entrada da leiloaria.
- Lance minimo.
- Margem estimada.
- Diferenca entre lance minimo e custo.
- Diferenca entre lance minimo e valor de entrada.

Regra:

```text
Definir lance minimo sem ver o custo somado do lote e decidir no escuro.
```

## 17. Regra Comercial da Leiloaria

A regra comercial definida foi:

```text
Comitente define o valor base.
Leiloaria trabalha com percentual fixo sobre esse valor.
O que vender acima desse percentual fica como resultado da leiloaria.
```

Exemplo:

| Produto | Valor base comitente |
|---|---:|
| Produto A | R$ 100 |
| Produto B | R$ 200 |
| Produto C | R$ 300 |
| Total | R$ 600 |

Percentual da leiloaria: 51%

| Produto | Calculo | Valor no pedido |
|---|---:|---:|
| Produto A | 100 x 51% | R$ 51 |
| Produto B | 200 x 51% | R$ 102 |
| Produto C | 300 x 51% | R$ 153 |
| Total |  | R$ 306 |

Se a leiloaria vender a 60%:

| Item | Valor |
|---|---:|
| Venda final | R$ 360 |
| Entrada da leiloaria | R$ 306 |
| Resultado extra da leiloaria | R$ 54 |

## 18. Comitente Interno vs Comitente Externo

O sistema precisa atender dois cenarios.

### 18.1 Comitente interno / leiloaria propria

Fluxo:

1. Etiquefacil monta lote.
2. Lote e enviado ao Lance360.
3. Lance360 coloca lote em evento.
4. Admin define percentual e lance minimo.
5. Ao marcar como arrematado, Lance360 gera pedido no Bling.
6. Pedido sai detalhado por produto.
7. Valor do produto no pedido = valor base x percentual da leiloaria.

### Pedido no Bling

```text
Cliente: LEILOARIA

Itens:
SKU A | qtd | valor base x percentual
SKU B | qtd | valor base x percentual
SKU C | qtd | valor base x percentual
```

### 18.2 Comitente externo

Para usuarios que nao sao da leiloaria propria, o Lance360 nao deve assumir geracao automatica de pedido sem configuracao.

Fluxo:

1. Comitente monta lote no Etiquefacil.
2. Lote e enviado ao Lance360 ou exportado para evento.
3. Lance360 organiza o evento.
4. Comitente baixa planilha do evento.
5. Comitente envia a planilha para leiloaria de terceiro.
6. Lance360 acompanha status.
7. Pedido no Bling so e gerado se houver integracao ou regra configurada.

### Configuracoes por comitente

Cada comitente deve poder ter:

- Percentual padrao.
- Gera pedido no Bling ou nao.
- Deposito padrao de evento.
- Modelo de planilha.
- Regra de retorno.
- Regra de comissao.
- Campos obrigatorios.

### Planilha do evento para comitente externo

| Campo |
|---|
| Evento |
| Codigo do lote |
| Comitente |
| SKU |
| Descricao |
| Quantidade |
| Valor base |
| Percentual sugerido |
| Valor de entrada da leiloaria |
| Lance minimo |
| Fotos/links |
| Observacoes |
| Status |

## 19. Estoque Durante o Evento

Quando o lote sai fisicamente para a leiloaria, ele nao pode continuar aparecendo como disponivel no deposito de origem.

Se o pedido de venda so nasce no arremate, durante o evento o saldo do Bling ficaria incorreto.

### Solucao

Criar um deposito no Bling:

```text
Em leilao
```

### Fluxo de estoque

Quando o lote e enviado para o Lance360/evento:

```text
Saida do deposito de origem
Entrada no deposito Em leilao
```

Quando o lote e arrematado:

```text
Pedido de venda baixa o estoque do deposito Em leilao
```

Quando o lote nao e arrematado e volta:

```text
Saida do deposito Em leilao
Entrada de volta no deposito de origem
```

### Beneficios

- O saldo vendavel fica correto.
- Marketplace nao anuncia item fisicamente fora da casa.
- O Bling mostra capital parado em evento.
- Fica possivel medir estoque em leilao por evento, comitente e data.

## 20. Lotes Nao Arrematados, Devolvidos e Remontagem

Nem todo lote nao arrematado deve voltar inteiro para outro evento.

### Reaproveitar lote inteiro

```text
Nao arrematado
   ↓
Disponivel para novo evento
   ↓
Entra em outro evento
```

### Devolver ou dissolver lote

```text
Nao arrematado
   ↓
Devolvido
   ↓
Sai do Lance360
   ↓
Volta ao Etiquefacil
   ↓
Dissolve agrupamento
   ↓
Itens voltam para triagem/estoque/remontagem
```

### Quando usar devolucao

- Lote montado errado.
- Lote fraco comercialmente.
- Necessidade de separar itens.
- Itens precisam voltar ao estoque.
- Itens serao remontados em novos lotes.
- Comitente externo solicitou retorno.

### Regra

```text
Lance360 controla o historico comercial do lote.
Etiquefacil controla a desmontagem fisica e a remontagem.
```

## 21. Expedicao

A expedicao precisa conversar com o WMS e com o Bling.

### Fluxo

```text
Pedido ou destino confirmado
   ↓
Produto entra em fila por deposito
   ↓
Sistema ordena coleta por FIFO
   ↓
Operador coleta no corredor
   ↓
Imprime etiqueta/documento
   ↓
Confirma saida fisica
   ↓
Bling recebe baixa/movimentacao
```

### Regras

- A fila deve ser por deposito.
- A coleta deve respeitar FIFO quando aplicavel.
- Produto em posicao errada deve bloquear ou alertar.
- Impressao no corredor deve ser possivel.
- A saida fisica deve refletir no Bling.

## 22. Bloqueios Operacionais

O sistema deve bloquear ou exigir autorizacao quando:

| Situacao | Acao recomendada |
|---|---|
| Produto sem confirmacao no Bling | Bloquear venda |
| Produto sem aceite fisico | Bloquear venda e expedicao |
| Produto em posicao errada | Bloquear coleta |
| Produto em transferencia aberta | Bloquear venda |
| Produto em lote de leilao | Bloquear venda direta |
| Produto em deposito Em leilao | Bloquear marketplace/venda normal |
| Produto com divergencia de quantidade | Bloquear fechamento |
| Falha na baixa do Bling | Bloquear finalizacao ate reprocessar |
| Lote sem custo visivel | Alertar antes de definir lance minimo |
| Foto comercial obrigatoria ausente | Bloquear envio ao evento, se regra exigir |

## 23. Auditoria e Historico

Toda entidade importante deve ter historico.

### Historico minimo

- Quem fez.
- Quando fez.
- Sistema de origem.
- Status anterior.
- Status novo.
- Quantidade alterada.
- Deposito anterior.
- Deposito novo.
- Posicao anterior.
- Posicao nova.
- Erro de integracao, se houver.

### Eventos que devem ficar auditados

- Importacao de lista.
- Criacao ou atualizacao de produto.
- Impressao de etiqueta.
- Triagem.
- Laudo.
- Foto.
- Aceite.
- Entrada em posicao.
- Criacao de estrutura de transferencia.
- Fechamento de estrutura.
- Criacao de lote.
- Envio ao Lance360.
- Entrada no deposito Em leilao.
- Vinculo a evento.
- Arremate.
- Pedido no Bling.
- Devolucao.
- Dissolucao de lote.
- Remontagem.
- Expedicao.

## 24. Cenarios de Erro

### 24.1 Produto criado no Etiquefacil, mas falhou no Bling

Acao:

- Marcar como pendente de sincronizacao.
- Permitir reprocessar.
- Nao liberar como vendavel.

### 24.2 Produto aceito fisicamente, mas falhou entrada de estoque no Bling

Acao:

- Manter produto como aceito fisicamente.
- Marcar estoque oficial pendente.
- Bloquear venda ate Bling confirmar.

### 24.3 Lote enviado ao Lance360, mas movimentacao para Em leilao falhou

Acao:

- Lote fica com alerta de estoque.
- Nao permitir arremate final/pedido ate corrigir movimentacao.
- Permitir reprocessamento da movimentacao.

### 24.4 Lote arrematado, mas pedido no Bling falhou

Acao:

- Status comercial pode ficar como arremate pendente de pedido.
- Nao finalizar evento como conciliado.
- Reprocessar pedido.

### 24.5 Quantidade fisica diferente da quantidade do sistema

Acao:

- Marcar divergencia.
- Bloquear fechamento da transferencia, lote ou expedicao.
- Exigir ajuste ou aprovacao de responsavel.

## 25. Ordem Completa do Processo

```text
1. Separacao 2.0
   Precifica produtos

2. Etiquefacil
   Importa lista
   Cadastra/atualiza produtos
   Envia produtos ao Bling
   Imprime etiquetas

3. Etiquefacil
   Faz triagem
   Registra laudo, destino e foto
   Define se segue para WMS, transferencia, leilao ou expedicao

4. WMS, quando aplicavel
   Bipa etiqueta
   Bipa posicao
   Valida deposito
   Registra entrada fisica
   Atualiza disponibilidade conforme regra

5. Bling
   Confirma produto, custo e estoque oficial

6. Etiquefacil
   Monta estrutura de transferencia
   ou monta lote de leilao

7. Etiquefacil → Lance360
   Envia lote de leilao pronto

8. Bling
   Move estoque do deposito de origem para deposito Em leilao

9. Lance360
   Cria evento
   Define percentual da leiloaria
   Define lance minimo
   Insere lotes no evento

10. Lance360
   Exporta planilha/catalogo do evento

11. Lance360
   Apos evento, classifica lotes:
   arrematado
   nao arrematado
   devolvido

12. Se arrematado
   Gera pedido de venda no Bling detalhado por produto
   Baixa estoque do deposito Em leilao

13. Se nao arrematado e reaproveitado
   Mantem lote disponivel para novo evento

14. Se devolvido
   Move estoque de Em leilao para origem
   Volta ao Etiquefacil
   Pode dissolver e remontar
```

## 26. Backlog Inicial Recomendado

Para iniciar a unificacao com menos risco, a ordem recomendada e:

1. Definir modelo de dados comum: produto, item fisico, etiqueta, lote, evento, deposito e movimentacao.
2. Confirmar Bling como cadastro mestre e mapear campos obrigatorios.
3. Implementar importacao do Separacao 2.0 para Etiquefacil.
4. Implementar criacao/atualizacao de produto no Bling via Etiquefacil.
5. Criar status operacional com donos claros.
6. Implementar aceite fisico separado de produto vendavel.
7. Criar estrutura de transferencia no Etiquefacil.
8. Criar lote de leilao no Etiquefacil com vinculo item a item.
9. Enviar lote pronto para Lance360.
10. Criar deposito Em leilao no fluxo Bling.
11. Implementar evento no Lance360 com custo, valor base, percentual e lance minimo.
12. Implementar arremate com pedido detalhado no Bling.
13. Implementar devolucao/dissolucao/remontagem de lote.
14. Implementar auditoria e reprocessamento de falhas.

## 27. Pontos de Decisao Antes do Desenvolvimento

Antes de implementar, confirmar:

- O SKU nasce sempre no Etiquefacil ou pode vir do Bling?
- O produto pode ter quantidade agregada ou sempre unidade fisica individual?
- Todo item em leilao vai obrigatoriamente para deposito Em leilao?
- O Lance360 sempre movimenta estoque ou apenas solicita movimentacao?
- Quem aprova divergencia de quantidade?
- Quando uma foto comercial e obrigatoria?
- Qual regra define que um lote pode ir para evento?
- Como o sistema identifica comitente interno vs externo?
- Qual evento gera pedido no Bling automaticamente?
- Como tratar custo ausente no Bling?

## 28. Conclusao

A arquitetura v3 transforma a unificacao em uma operacao mais controlada.

O desenho final fica:

```text
Separacao 2.0
   preco e referencia

Etiquefacil
   produto fisico, etiqueta, triagem, aceite, transferencia e lote de leilao

WMS
   posicao fisica, movimentacao, FIFO e expedicao

Lance360
   evento, leiloaria, arremate, devolucao e resultado comercial

Bling
   produto oficial, custo, estoque, pedido e margem
```

O ponto mais importante e separar tres verdades:

```text
Verdade fisica = Etiquefacil / WMS
Verdade comercial = Lance360
Verdade fiscal e estoque = Bling
```

Quando essas tres verdades conversam sem se atropelar, o sistema deixa de ser duplicado e passa a ser uma linha unica de operacao.
