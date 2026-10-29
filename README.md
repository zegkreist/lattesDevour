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

- **Não há integração com serviço de quebra de captcha (2Captcha etc.), de propósito.** O captcha é o
  controle do CNPq contra extração em massa; contorná-lo não é algo que este projeto faz.
- O coletor funciona com **humano no circuito**: abre o CV num Chromium real, marca
  `aguardando_captcha`, e espera você resolver pelo noVNC e confirmar o download. Se ninguém
  responder em `CAPTCHA_TIMEOUT_MS` (10 min), **pausa** a coleta e devolve o ID à fila.
- Para volume (o Brasil inteiro) o caminho é o **Extrator Lattes do CNPq** (web service para
  instituições de ensino/pesquisa; pedido por `atendimento@cnpq.br`, assunto “Solicitação de
  acesso ao Lattes Extrator”). O que ele entregar (`.xml` ou `.zip`) é só soltar em
  `data/app/import/`: entra no mesmo parser, sem captcha.
- O CNPq publica a lista de IDs de todos os currículos
  (<https://memoria.cnpq.br/web/portal-lattes/extracoes-de-dados>). Cole na aba Coleta → “Adicionar IDs”.

> **Não verificado:** o passo pós-captcha (o clique de confirmação e o formato exato do arquivo
> baixado) depende de uma pessoa resolver um captcha real; o fluxo foi implementado a partir da
> estrutura da página, e a URL é configurável (`LATTES_DOWNLOAD_URL`) caso o site mude.

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

- Coleta nominal exige captcha humano (acima); descoberta via ORCID cobre só parte dos pesquisadores.
- O grafo só liga pesquisadores **já coletados** (coautores externos com ID ainda não viram nós).
- `ORIENTACOES-EM-ANDAMENTO`, bancas, eventos e projetos (`DADOS-COMPLEMENTARES`) ainda não são extraídos.
- O backup em nuvem faz tarball completo dos XMLs a cada rodada (não incremental).
