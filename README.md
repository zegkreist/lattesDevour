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

### Container único

```bash
./single.sh                                 # build local e sobe Postgres + app num container só
./single.sh zegkreist/lattesdevour:latest   # mesma coisa, com a imagem do Docker Hub
./single.sh --stop
```

Usa os mesmos `./data/app` e `./data/pg` do compose (o Postgres roda como uid 999 e locale
`en_US.UTF-8`, como na imagem oficial), por isso o script derruba o compose antes de subir:
os dois nunca podem abrir o banco ao mesmo tempo. Cria o `.env` se não existir. A imagem é o
estágio `single` do `Dockerfile`; o compose usa o estágio `app`. Para publicar no Docker Hub há
um `build-and-push.sh` local (fora do git, contém credenciais).

### ZimaOS / CasaOS

1. Publique a imagem: `./build-and-push.sh` (gera `zegkreist/lattesdevour:latest`, amd64).
2. No ZimaOS: App Store → “+” → Instalar app personalizado → Importar → cole
   [`zimaos/docker-compose.yml`](zimaos/docker-compose.yml), **trocando as duas senhas**.
3. Painel em `http://<ip-do-zima>:8080`; o link do noVNC no painel aponta para o mesmo host,
   porta 6080 (defina `NOVNC_URL` se mapear outra porta). Ritmo e caminho: aba Coleta; chave do 2Captcha: Configurações.

Dados em `/media/firstBlood/lattesdevour/{app,pg}` (ajuste no compose se usar outro disco). Diferente do setup local, as portas ficam abertas
na rede de casa e o painel não tem login: não exponha o NAS para a internet com essas portas.
Para atualizar: publique de novo e faça pull/recreate do app.

## Captcha: leia isto

O Lattes **não serve mais o XML público**: `download.do?metodo=apresentar&idcnpq=` responde vazio
para qualquer ID (verificado em 2026-10-30). O caminho é a página pública do CV:
`cv?id=<16 dígitos>` → `visualizacv.do?id=K…`, com **reCAPTCHA v2** e o botão “Submeter”, que mostra
o currículo em **HTML**. A busca por nome (`busca.do`) usa reCAPTCHA v3 invisível. Por isso:

- **Caminho de download (aba Coleta, em teste):** “Link direto do CV” (o descrito abaixo, reCAPTCHA
  v2) ou “Prévia da busca” (`preview.do?id=K…` → `abreCV()`, reCAPTCHA v3 invisível, o fluxo do
  scriptLattes; se não abrir o CV, cai no link direto). A fila guarda por qual caminho cada CV veio
  (`fila.caminho`) e a aba mostra a contagem. A prévia não foi testada contra o Lattes neste ambiente.
- **Modo automático (2Captcha):** com a chave cadastrada em Configurações (validada pelo saldo antes
  de salvar; a do painel vale sobre `TWOCAPTCHA_API_KEY` do `.env`), o coletor manda o reCAPTCHA
  (sitekey + URL) para o 2Captcha, põe o token no formulário e submete. Se o CV não abrir, cai
  para o modo humano abaixo. Chave inválida, saldo zerado ou IP bloqueado no 2Captcha **pausam** a
  coleta; captcha insolúvel ou timeout (`TWOCAPTCHA_TIMEOUT_MS`, 3 min) contam como tentativa do CV.
- **Modo humano (sem chave):** marca `aguardando_captcha` e espera você resolver pelo noVNC e
  clicar em Submeter. Se ninguém responder em `CAPTCHA_TIMEOUT_MS` (10 min), **pausa** a coleta e
  devolve o ID à fila.
- **O que é salvo:** `data/app/html/<id>.html` (status `html` na fila até o parser de HTML rodar,
  depois `parseado`). ID que não existe no Lattes (redireciona para `erro.jsp`) vira `sem_cv` com essa mensagem.
  Página inesperada (nem captcha nem CV) vai para `html/_debug/` e o ID
  fica `sem_cv` com o caminho no erro. A URL é configurável (`LATTES_CV_URL`).
- **Ritmo:** nos dois modos, de **60 a 600 CVs por hora** (padrão 60; 600/h = 1 CV a cada 6 s), na aba Coleta, que
  mostra o intervalo resultante. Os CVs são espaçados de início a início (3600/N s, ±20%, mínimo de
  2 s entre um e outro) e uma janela deslizante de 1 h serve de trava. Custo de referência do
  2Captcha: alguns dólares por mil captchas, ou seja, uns US$ 4–5/dia a 60/h rodando 24 h.
- Para volume (o Brasil inteiro) o caminho é o **Extrator Lattes do CNPq** (web service para
  instituições de ensino/pesquisa; pedido por `atendimento@cnpq.br`, assunto “Solicitação de
  acesso ao Lattes Extrator”). O que ele entregar (`.xml` ou `.zip`) é só soltar em
  `data/app/import/`: entra no parser de XML, sem captcha.
- O CNPq publica a lista de IDs de todos os currículos
  (<https://memoria.cnpq.br/web/portal-lattes/extracoes-de-dados>). Cole na aba Coleta → “Adicionar CVs” com destino “fim da fila”.

> **Não verificado:** a resolução pelo 2Captcha de ponta a ponta (token aceito pelo Lattes) e o
> formato do HTML do CV; até então o fluxo foi conferido até o captcha (sitekey, formulário e campos).

## Como achar pesquisadores

| Fonte | Como | Cobertura |
|---|---|---|
| CVs específicos | aba Coleta → “Adicionar CVs” (destino “topo da fila” ou “topo + rede”): um ou vários links (`lattes.cnpq.br/<ID>`, `cv?id=`) ou IDs de 16 dígitos; vão para o **topo da fila** na ordem colada e o card acompanha cada um até estar no banco. **“+ rede”** (1 ou 2 níveis): quem aparece no CV com link do Lattes (orientador, orientados, coautores) vem logo depois; CV já coletado não é baixado de novo, só reprocessado para priorizar a rede. Link com ID interno (`visualizacv.do?id=K…`) não serve | prioridade: pedido > rede > resto |
| Lista de IDs | aba Coleta → “Adicionar CVs” com destino “fim da fila” (aceita URLs `lattes.cnpq.br/<id>`, CSV, lista do CNPq) | o que você tiver |
| Instituições-alvo + ORCID | aba Instituições → lista de nomes → “Descobrir” (API pública do ORCID por afiliação; lê o link do Lattes no perfil) | só quem declarou o Lattes no ORCID (taxa varia) |
| Nome (+ instituição) | aba Instituições → “Pesquisador por nome (ORCID)” (mesma fonte) | idem |
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
- `parsers/lattes-html-v1/` — a **página pública do CV** (o que o coletor salva). Gera o mesmo
  `ParsedCV`, com os mesmos tipos de obra e a mesma chave (DOI ou `tipo|título|ano`), para a obra de
  dois coautores — um vindo do XML e outro do HTML — virar uma só. Lê identificação, endereço
  profissional, formação, atuação, áreas, produções (artigos com DOI/ISSN/periódico do `cvuri`) e
  orientações concluídas; os blocos “Pós-doutorado” e “Livre-docência” entram na formação. Participação
  em eventos, orientações em andamento, bancas, projetos (pesquisa, extensão, ensino,
  desenvolvimento), corpo editorial, revisão e comitês de assessoramento ficam de fora, como no XML. Listas que misturam tipos (“Outras produções bibliográficas”, “Demais tipos de produção
  técnica”, “Entrevistas…”) usam o parêntese de cada item, que é o nome do elemento no XML
  (`(Tradução/Artigo)` → `traducao`). Coautor com link para o próprio Lattes já grava o ID na
  autoria, então a aresta de coautoria existe antes de coletar o CV dele. Bloco `h1` desconhecido vai para “Elementos sem parser” como `html:<bloco>`. Havendo XML
  e HTML do mesmo ID, vale o XML.
- **Coleta em cadeia:** todo link `lattes.cnpq.br/<id>` de outra pessoa na página (orientador,
  orientados, coautores) entra na fila com origem `cv` e o nome como dica; quem já estava na fila
  (ex.: veio do ORCID) não duplica, só ganha o nome se não tinha.
- Os XMLs e HTMLs crus ficam em `data/app/xml/` e `data/app/html/`, então **trocar um parser não
  exige baixar de novo**: Configurações → “Reprocessar todos” repassa todo XML/HTML em disco,
  inclusive arquivos soltos em `data/app/html/` (ex.: salvos à mão do navegador).
- Amostras reais de HTML em `data/amostras/<id>.html` (fora do git) entram num teste que exige
  parse sem erro, sem seção desconhecida e toda obra com autor e ano.
- **Pegar amostras para um parser novo:** no Painel, card Parsers → “Elementos sem parser”, clique
  no elemento: lista os CVs que o têm, com “baixar” (o XML/HTML cru) e “Baixar todos (.zip)”. Os
  arquivos vão para `data/amostras/` e viram teste.

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

Obras são **deduplicadas** entre CVs (por DOI ou tipo+título+ano). `obra_fonte` guarda **o que cada
CV diz** da obra (`parser`, `dados`, `autores`, `tags`, palavras-chave e áreas), e a obra é **refeita a
partir das fontes** a cada (re)processamento: `dados` é a fusão chave a chave (XML vence HTML); tags,
palavras-chave e áreas são a união; a autoria é a lista da melhor fonte (XML, senão a mais
completa) com o ID Lattes que qualquer fonte conheça para aquele nome. Por isso **reprocessar um CV
troca só a contribuição dele** e nada velho fica (autor corrigido, UF que mudou, instituição órfã),
sem apagar o banco. Campos de valor único (natureza, veículo,
ISSN, idioma...) seguem a mesma regra: fonte XML sempre atualiza; HTML só quando a obra não tem
fonte XML, senão preenche o que falta. Os detalhes usam os **nomes de atributo do XML** nas duas
fontes (`VOLUME`, `PAGINA-INICIAL`, `NOME-DO-EVENTO`, `CIDADE-DO-EVENTO`, `NOME-DA-EDITORA`,
`ORGANIZADORES`, `NATUREZA`...); o HTML extrai isso do texto da citação e guarda o texto em
`CITACAO`. Ex.: `SELECT dados->>'CIDADE-DO-EVENTO', count(*) FROM obra GROUP BY 1`.
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

**Parse em paralelo:** o pipeline processa `PARSE_CONCORRENCIA` CVs ao mesmo tempo (padrão 4, máx. 8;
o pool do Postgres tem 10 conexões). Cada CV grava as obras em ordem fixa (pela chave), e conflitos
transitórios entre CVs que compartilham obras (deadlock, FK de instituição órfã) refazem a transação
sozinhos, até 4 vezes.

## Cópia em Parquet (sem senha)

Um `<tabela>.parquet` por tabela (compressão GZIP), em `data/app/exports/` (no ZimaOS,
`/media/firstBlood/lattesdevour/app/exports/`), sobrescrito a cada exportação: junto do backup
diário (`BACKUP_HOUR`) e pelo botão em Configurações. Abre direto, sem o Postgres:

```python
import pandas as pd; obras = pd.read_parquet('exports/obra.parquet')
```
```sql
-- duckdb
SELECT tipo, count(*) FROM 'exports/obra.parquet' GROUP BY 1;
```

Listas (`text[]`) viram listas; `jsonb` vira texto JSON. Ficam de fora `settings` (guarda a chave
do 2Captcha), `schema_migrations` e as colunas `tsv` (índice de busca). Quem gera é o DuckDB, que
lê o Postgres pela extensão `postgres`, baixada uma vez para `data/app/duckdb-ext/` (precisa de
internet na primeira exportação).

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

- Coleta nominal exige captcha (humano ou 2Captcha, acima); descoberta via ORCID acha o link do Lattes em só ~5% dos perfis.
- UF/região de quem não publica “Endereço profissional” é **inferida** pela instituição: a atual e, depois, as da formação (em andamento, depois a mais recente). Vale a UF já conhecida no banco para aquela instituição (aprendida do endereço de outro CV) ou a deduzida do nome (sigla: “USP”, “UFG”, “PUC-SP”; estado: “Universidade Federal de Goiás”). O log de parse registra “UF X inferida pela instituição Y”; quando uma instituição ganha UF, quem estava ligado a ela sem UF volta para o parse. Instituição sem pista nenhuma (“Universidade Candido Mendes”) não é adivinhada.
- O parser de HTML foi validado em 8 CVs reais (Letras, Comunicação, Psicologia, Imunologia, Tradução/Libras, Museologia); áreas com produção muito diferente (patentes, software, produção artística) ainda não foram vistas.
- O grafo só liga pesquisadores **já coletados** (coautores externos com ID ainda não viram nós).
- `ORIENTACOES-EM-ANDAMENTO`, bancas, eventos e projetos (`DADOS-COMPLEMENTARES`) ainda não são extraídos.
- O backup em nuvem faz tarball completo dos XMLs a cada rodada (não incremental).
