# Lattes Devour

Coleta currículos Lattes, guarda o XML cru em disco, converte em tabelas num PostgreSQL
(pesquisadores, obras, autorias, orientações) e serve um painel com busca por região, tema,
título, instituição e tags, mais um grafo de colaboradores e obras. Inspirado no
[scriptLattes](https://github.com/jpmenachalco/scriptLattes), mas guardando num banco em vez de
gerar um site estático.

```
 navegador ──► app (Node/TS)  ── API + front + coletor (Chromium) + parse + backup
                 │   └── noVNC :6080  (o navegador do coletor, para resolver captcha)
                 └──► db (Postgres 17)
   host:  ./data/pg  (banco)   ./data/app  (xml/, import/, backups/, browser-profile/)
```

## Subir

```bash
cp .env.example .env        # ajuste a senha do banco e LATTES_UID/GID (id -u; id -g)
docker compose up -d --build
# painel: http://localhost:8080      navegador do coletor (noVNC): http://localhost:6080
```

Dois containers (`app`, `db`). Tudo que importa fica no host em `./data` e sobrevive a
`docker compose down`. As portas só escutam em `127.0.0.1`.

## Captcha: leia isto

O Lattes protege **a busca e o download do XML com reCAPTCHA v2, a cada currículo**
(verificado nas páginas `busca.do` e `visualizacv.do`; a busca sem token devolve “Nenhum
resultado”). Por isso:

- **Modo automático (2Captcha):** com a chave cadastrada na aba Coleta (validada pelo saldo antes
  de salvar; a do painel vale sobre `TWOCAPTCHA_API_KEY` do `.env`), o coletor manda o
  reCAPTCHA (sitekey + URL) para o 2Captcha, injeta o token na página, chama o callback do
  reCAPTCHA e clica no botão de confirmação (achado pelo texto “baixar/download/confirmar/enviar”
  ou por `LATTES_DOWNLOAD_SUBMIT`). Se o token não destravar o download em 30 s, o CV cai para o
  modo humano abaixo. Chave inválida, saldo zerado ou IP bloqueado no 2Captcha **pausam** a
  coleta; captcha insolúvel ou timeout (`TWOCAPTCHA_TIMEOUT_MS`, 3 min) contam como tentativa do CV.
- **Modo humano (sem chave):** abre o CV num Chromium real, marca `aguardando_captcha`, e espera
  você resolver pelo noVNC e confirmar o download. Se ninguém responder em `CAPTCHA_TIMEOUT_MS`
  (10 min), **pausa** a coleta e devolve o ID à fila.
- **Ritmo:** nos dois modos, de **60 a 180 CVs por hora** (padrão 60), ajustável na aba Coleta, que
  mostra o intervalo resultante. Os CVs são espaçados de início a início (3600/N s, ±20%, mínimo de
  5 s entre um e outro) e uma janela deslizante de 1 h serve de trava. Custo de referência do
  2Captcha: alguns dólares por mil captchas, ou seja, uns US$ 4–5/dia a 60/h rodando 24 h.
- Para volume (o Brasil inteiro) o caminho é o **Extrator Lattes do CNPq** (web service para
  instituições de ensino/pesquisa; pedido por `atendimento@cnpq.br`, assunto “Solicitação de
  acesso ao Lattes Extrator”). O que ele entregar (`.xml` ou `.zip`) é só soltar em
  `data/app/import/`: entra no mesmo parser, sem captcha.
- O CNPq publica a lista de IDs de todos os currículos
  (<https://memoria.cnpq.br/web/portal-lattes/extracoes-de-dados>). Cole na aba Coleta → “Adicionar IDs”.

> **Não verificado:** o passo pós-captcha (o clique de confirmação, o callback do reCAPTCHA e o
> formato exato do arquivo baixado) não foi testado contra um CV real; o fluxo foi implementado a
> partir da estrutura genérica da página, e a URL e o botão são configuráveis
> (`LATTES_DOWNLOAD_URL`, `LATTES_DOWNLOAD_SUBMIT`) caso o site mude. O cliente do 2Captcha tem
> teste com a API mockada.

## Como achar pesquisadores

| Fonte | Como | Cobertura |
|---|---|---|
| Lista de IDs | aba Coleta → colar texto (aceita URLs `lattes.cnpq.br/<id>`, CSV, lista do CNPq) | o que você tiver |
| Instituições-alvo + ORCID | aba Instituições → lista de nomes → “Descobrir” (API pública do ORCID por afiliação; lê o link do Lattes no perfil) | só quem declarou o Lattes no ORCID (taxa varia) |
| Nome (+ instituição) | aba Coleta → “Achar pesquisador por nome” (mesma fonte) | idem |
| XMLs do Extrator | soltar em `data/app/import/` | o que o CNPq liberar |

A busca nativa do Lattes (por nome/instituição) também exige captcha e não foi automatizada.

## Parsers (o “motor”)

O XML segue o XSD oficial (`docs/lattes.xsd`, do CNPq). A estrutura:

- `server/src/parsers/engine.ts` — registro de `CVParser`. Cada formato de CV é um parser com
  `matches(raiz)` e `parse(raiz)`; o primeiro que reconhece o XML o processa.
- `parsers/lattes-v1/` — o formato atual, dividido em `SectionParser` (um por seção do CV):
  `dadosGerais`, `producao` (bibliográfica e técnica), `outraProducao` (orientações etc.).
- Produções são extraídas por **convenção do XSD** (todo elemento com filho `DADOS-BASICOS-*`):
  um tipo novo de produção é absorvido sem código (o tipo vira o nome do elemento). O que nem
  isso cobre aparece no painel em **“Elementos sem parser”**.
- Os XMLs crus ficam em `data/app/xml/`, então **trocar um parser não exige baixar de novo**:
  botão “Reprocessar”.

### Adicionar um parser

1. **Tipo novo dentro do formato atual:** normalmente nada (coletor genérico). Para dar um nome
   bonito, inclua em `TIPO_POR_ITEM` (`producao.ts`). Para tratar à mão, escreva um `SectionParser`
   e some em `SECOES` (`lattes-v1/index.ts`).
2. **Formato novo do CV:** crie `parsers/lattes-v2/` com um `CVParser` (`versao: 2`) e registre em
   `parsers/index.ts`. Reprocesse pelo painel.

## Banco

Colunas `*_norm` guardam texto sem acento/minúsculo (mesma função na gravação e na busca);
`pg_trgm` + `tsvector('portuguese')` para busca aproximada; **tags** em `text[]` com índice GIN:
`uf:MG`, `regiao:sudeste`, `inst:<slug>`, `tema:<grande-area>`, `area:<area>`, `tipo:artigo`,
`ano:2021`, `decada:2020s`, `kw:<palavra-chave>`, `idioma:*`, `tem-doi`. Os filtros do painel e
do grafo viram `tags @> ARRAY[...]`.

Obras são **deduplicadas** entre CVs (por DOI ou tipo+título+ano); `obra_fonte` diz quem declarou,
`autoria` guarda os autores (com o ID Lattes quando existe). Coautoria = autores com ID na mesma
obra; orientação (`orientacao`) vira outra aresta do grafo.

**Dados pessoais:** o XML traz CPF, RG, filiação, nascimento e endereço residencial. O parser
**não lê** nada disso (há teste garantindo); só dado profissional/acadêmico. Se for publicar o
site, decida o que expor e ofereça remoção (LGPD).

## Backup

Diário às `BACKUP_HOUR` (Brasília), mais o botão em Configurações: `pg_dump` + tarball dos XMLs
em `data/app/backups/` (mantém os últimos `BACKUP_KEEP`). Se `BACKUP_S3_BUCKET` e as credenciais
AWS estiverem no `.env`, sobe também para `s3://BUCKET/PREFIXO`. Recoletar um XML custa um captcha,
então o tarball dos XMLs vale tanto quanto o dump. Restaurar: `pg_restore -d lattes arquivo.dump`.

## Desenvolvimento

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17   # banco de teste
cd server && npm i && TEST_DATABASE_URL=postgres://postgres:t@localhost:55432/t npm test
cd web && npm i && npm run dev     # proxy /api -> :8080
```

Os testes usam um XML sintético montado a partir do XSD (`server/test/fixtures/`); não há XML real
no repositório. Ao receber o primeiro XML real, rode-o pelo parser e confira o painel
“Elementos sem parser”.

## Limitações conhecidas

- Coleta nominal exige captcha (humano ou 2Captcha, acima); descoberta via ORCID cobre só parte dos pesquisadores.
- O grafo só liga pesquisadores **já coletados** (coautores externos com ID ainda não viram nós).
- `ORIENTACOES-EM-ANDAMENTO`, bancas, eventos e projetos (`DADOS-COMPLEMENTARES`) ainda não são extraídos.
- O backup em nuvem faz tarball completo dos XMLs a cada rodada (não incremental).
