-- Orientador: pesquisador coletado que tem ao menos uma orientação no próprio CV. É uma view (e
-- não uma tabela) para nunca sair de sincronia com orientacao; entra na cópia em Parquet.
CREATE VIEW orientador AS
SELECT o.orientador_id AS id,
       p.nome,
       count(*)::int AS orientacoes,
       count(*) FILTER (WHERE o.nivel = 'pos_doutorado')::int AS pos_doutorado,
       count(*) FILTER (WHERE o.nivel = 'doutorado')::int AS doutorado,
       count(*) FILTER (WHERE o.nivel = 'mestrado')::int AS mestrado,
       count(*) FILTER (WHERE o.nivel = 'outras')::int AS outras,
       count(DISTINCT o.orientado_lattes_id)::int AS orientados_com_lattes,
       min(o.ano) AS primeiro_ano,
       max(o.ano) AS ultimo_ano
FROM orientacao o JOIN pesquisador p ON p.id = o.orientador_id
GROUP BY o.orientador_id, p.nome;
