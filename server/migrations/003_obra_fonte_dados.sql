-- Cada CV que declara uma obra diz algo sobre ela (detalhes da citação, natureza, ISSN...).
-- obra_fonte passa a guardar a versão de cada CV; obra.dados é a fusão delas, chave a chave,
-- com o XML vencendo o HTML (ver store/ingest.ts). Fontes antigas herdam o dados atual da obra.
ALTER TABLE obra_fonte ADD COLUMN parser text, ADD COLUMN dados jsonb NOT NULL DEFAULT '{}';
UPDATE obra_fonte f SET dados = o.dados FROM obra o WHERE o.id = f.obra_id;
UPDATE obra_fonte f SET parser = l.parser FROM parse_log l WHERE l.pesquisador_id = f.pesquisador_id;
