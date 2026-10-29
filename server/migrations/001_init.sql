-- lattesDevour: schema inicial.
-- Texto pesquisável é normalizado no app (minúsculas, sem acento) e gravado em *_norm;
-- por isso não precisamos da extensão unaccent. pg_trgm cobre busca aproximada.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE settings (
  chave text PRIMARY KEY,
  valor jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Instituições que o operador quer cobrir (lista de alvos da descoberta).
CREATE TABLE instituicao_alvo (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  nome_norm text NOT NULL UNIQUE,
  uf char(2),
  status text NOT NULL DEFAULT 'pendente', -- pendente | descobrindo | concluida | erro
  descobertos int NOT NULL DEFAULT 0,
  descoberta_cursor int NOT NULL DEFAULT 0, -- offset da paginação da fonte
  descoberta_total int,                      -- total que a fonte diz existir
  ultimo_erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- Fila de coleta: um Lattes ID por linha.
CREATE TABLE fila (
  lattes_id text PRIMARY KEY CHECK (lattes_id ~ '^[0-9]{16}$'),
  status text NOT NULL DEFAULT 'pendente',
  -- pendente | baixando | aguardando_captcha | baixado | parseado | erro | sem_cv
  origem text NOT NULL DEFAULT 'manual',   -- orcid | lista | manual | import
  nome_hint text,
  instituicao_alvo_id int REFERENCES instituicao_alvo(id) ON DELETE SET NULL,
  tentativas int NOT NULL DEFAULT 0,
  ultimo_erro text,
  xml_path text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fila_status_idx ON fila (status, criado_em);
CREATE INDEX fila_alvo_idx ON fila (instituicao_alvo_id, status);

CREATE TABLE instituicao (
  id serial PRIMARY KEY,
  codigo text,
  nome text NOT NULL,
  nome_norm text NOT NULL UNIQUE,
  uf char(2),
  regiao text,
  pais text
);

-- Só dados profissionais/acadêmicos. CPF, RG, passaporte, nascimento, filiação, raça/cor e
-- endereço residencial existem no XML mas NÃO são lidos pelo parser (minimização, LGPD).
CREATE TABLE pesquisador (
  id text PRIMARY KEY REFERENCES fila(lattes_id),
  nome text NOT NULL,
  nome_norm text NOT NULL,
  nomes_citacao text[] NOT NULL DEFAULT '{}',
  orcid text,
  resumo text,
  instituicao_id int REFERENCES instituicao(id),
  uf char(2),
  cidade text,
  regiao text,
  grandes_areas text[] NOT NULL DEFAULT '{}',
  areas text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  formacao jsonb NOT NULL DEFAULT '[]',
  atuacoes jsonb NOT NULL DEFAULT '[]',
  data_atualizacao_cv date,
  parser_versao int NOT NULL,
  xml_sha256 text,
  coletado_em timestamptz NOT NULL DEFAULT now(),
  tsv tsvector
);
CREATE INDEX pesquisador_nome_trgm ON pesquisador USING gin (nome_norm gin_trgm_ops);
CREATE INDEX pesquisador_tags ON pesquisador USING gin (tags);
CREATE INDEX pesquisador_tsv ON pesquisador USING gin (tsv);
CREATE INDEX pesquisador_inst ON pesquisador (instituicao_id);
CREATE INDEX pesquisador_uf ON pesquisador (uf);
CREATE INDEX pesquisador_regiao ON pesquisador (regiao);

-- Obra canônica: o mesmo artigo aparece no CV de cada coautor; dedup por DOI ou
-- (tipo, título normalizado, ano).
CREATE TABLE obra (
  id bigserial PRIMARY KEY,
  chave text NOT NULL UNIQUE,
  tipo text NOT NULL,          -- artigo, evento, livro, capitulo, texto_jornal, patente, ...
  subtipo text,
  titulo text NOT NULL,
  titulo_norm text NOT NULL,
  ano int,
  doi text,
  idioma text,
  veiculo text,                -- periódico / evento / editora
  issn text,
  isbn text,
  pais text,
  palavras_chave text[] NOT NULL DEFAULT '{}',
  grandes_areas text[] NOT NULL DEFAULT '{}',
  areas text[] NOT NULL DEFAULT '{}',
  tags text[] NOT NULL DEFAULT '{}',
  dados jsonb NOT NULL DEFAULT '{}',
  tsv tsvector,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX obra_titulo_trgm ON obra USING gin (titulo_norm gin_trgm_ops);
CREATE INDEX obra_tags ON obra USING gin (tags);
CREATE INDEX obra_kw ON obra USING gin (palavras_chave);
CREATE INDEX obra_tsv ON obra USING gin (tsv);
CREATE INDEX obra_ano ON obra (ano);
CREATE INDEX obra_tipo ON obra (tipo, ano);
CREATE INDEX obra_doi ON obra (doi) WHERE doi IS NOT NULL;

-- Qual CV declarou qual obra (fonte de verdade da associação pesquisador-obra).
CREATE TABLE obra_fonte (
  obra_id bigint NOT NULL REFERENCES obra(id) ON DELETE CASCADE,
  pesquisador_id text NOT NULL REFERENCES pesquisador(id) ON DELETE CASCADE,
  PRIMARY KEY (obra_id, pesquisador_id)
);
CREATE INDEX obra_fonte_pesq ON obra_fonte (pesquisador_id);

CREATE TABLE autoria (
  obra_id bigint NOT NULL REFERENCES obra(id) ON DELETE CASCADE,
  ordem int NOT NULL,
  nome text NOT NULL,
  nome_norm text NOT NULL,
  nome_citacao text,
  autor_lattes_id text, -- NRO-ID-CNPQ quando o autor tem Lattes (ou o dono do CV, resolvido por nome)
  PRIMARY KEY (obra_id, ordem)
);
CREATE INDEX autoria_autor ON autoria (autor_lattes_id) WHERE autor_lattes_id IS NOT NULL;
CREATE INDEX autoria_nome_trgm ON autoria USING gin (nome_norm gin_trgm_ops);

CREATE TABLE orientacao (
  id bigserial PRIMARY KEY,
  orientador_id text NOT NULL REFERENCES pesquisador(id) ON DELETE CASCADE,
  orientado_nome text NOT NULL,
  orientado_lattes_id text,
  nivel text NOT NULL,          -- mestrado | doutorado | pos_doutorado | outras
  titulo text,
  ano int,
  instituicao text,
  curso text,
  UNIQUE (orientador_id, nivel, orientado_nome, titulo)
);
CREATE INDEX orientacao_orientado ON orientacao (orientado_lattes_id) WHERE orientado_lattes_id IS NOT NULL;

-- Relatório do parser por CV: elementos que nenhum parser conhece (mudança de formato).
CREATE TABLE parse_log (
  pesquisador_id text PRIMARY KEY REFERENCES fila(lattes_id) ON DELETE CASCADE,
  parser text NOT NULL,
  versao int NOT NULL,
  obras int NOT NULL DEFAULT 0,
  orientacoes int NOT NULL DEFAULT 0,
  desconhecidos jsonb NOT NULL DEFAULT '[]',
  avisos jsonb NOT NULL DEFAULT '[]',
  em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backup_log (
  id serial PRIMARY KEY,
  em timestamptz NOT NULL DEFAULT now(),
  arquivo text,
  bytes bigint,
  destino text,
  ok boolean NOT NULL,
  erro text
);
