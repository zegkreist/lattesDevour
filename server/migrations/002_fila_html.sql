-- O Lattes não serve mais o XML público: o coletor guarda o HTML da página do CV.
-- status 'html' = HTML salvo, aguardando o parser de HTML.
ALTER TABLE fila ADD COLUMN html_path text;
