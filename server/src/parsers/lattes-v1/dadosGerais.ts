import { clean, toInt } from '../../util/text.js';
import { arr, attr, attrs, children } from '../helpers.js';
import type { Node, SectionParser } from '../types.js';

// Lê SÓ o que é profissional/acadêmico. CPF, RG, passaporte, nascimento, filiação, raça/cor
// e endereço residencial estão no XML mas ficam de fora de propósito (minimização, LGPD).
export const dadosGerais: SectionParser = {
  name: 'dados-gerais',
  element: 'DADOS-GERAIS',
  parse(dg: Node, { cv, warn }) {
    cv.nome = attr(dg, 'NOME-COMPLETO') ?? '';
    cv.nomesCitacao = (attr(dg, 'NOME-EM-CITACOES-BIBLIOGRAFICAS') ?? '')
      .split(';')
      .map((s) => clean(s))
      .filter((s): s is string => !!s);
    const orcid = attr(dg, 'ORCID-ID');
    cv.orcid = orcid ? (/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/.exec(orcid)?.[1] ?? null) : null;
    cv.resumo = attr(arr(dg['RESUMO-CV'])[0], 'TEXTO-RESUMO-CV-RH');

    // Endereço profissional (nunca o residencial).
    const end = arr(dg['ENDERECO'])[0];
    const prof = arr(end?.['ENDERECO-PROFISSIONAL'])[0];
    if (prof) {
      const nome = attr(prof, 'NOME-INSTITUICAO-EMPRESA');
      if (nome) {
        cv.instituicao = {
          codigo: attr(prof, 'CODIGO-INSTITUICAO-EMPRESA'),
          nome,
          uf: attr(prof, 'UF')?.toUpperCase().slice(0, 2) ?? null,
          cidade: attr(prof, 'CIDADE'),
          pais: attr(prof, 'PAIS'),
        };
      }
    } else {
      warn('sem endereço profissional');
    }

    // Formação acadêmica: cada filho (GRADUACAO, MESTRADO, ...) é um nível.
    for (const [nivel, f] of children(arr(dg['FORMACAO-ACADEMICA-TITULACAO'])[0])) {
      const a = attrs(f);
      cv.formacao.push({
        nivel: nivel.toLowerCase().replace(/-/g, '_'),
        instituicao: a['NOME-INSTITUICAO'] ?? null,
        curso: a['NOME-CURSO'] ?? null,
        inicio: toInt(a['ANO-DE-INICIO']),
        fim: toInt(a['ANO-DE-CONCLUSAO']),
        titulo: a['TITULO-DA-DISSERTACAO-TESE'] ?? a['TITULO-DO-TRABALHO-DE-CONCLUSAO-DE-CURSO'] ?? null,
        orientador:
          a['NOME-COMPLETO-DO-ORIENTADOR'] ?? a['NOME-DO-ORIENTADOR'] ?? a['NOME-ORIENTADOR-DOUT'] ?? null,
      });
    }

    for (const [, at] of children(arr(dg['ATUACOES-PROFISSIONAIS'])[0])) {
      const a = attrs(at);
      const v = arr(at['VINCULOS']).map((x) => attrs(x));
      const last = v[v.length - 1] ?? {};
      cv.atuacoes.push({
        instituicao: a['NOME-INSTITUICAO'] ?? null,
        vinculo: last['TIPO-DE-VINCULO'] ?? null,
        enquadramento: last['ENQUADRAMENTO-FUNCIONAL'] ?? null,
        inicio: toInt(last['ANO-INICIO']),
        fim: toInt(last['ANO-FIM']),
      });
    }

    for (const [, ar] of children(arr(dg['AREAS-DE-ATUACAO'])[0])) {
      const a = attrs(ar);
      if (a['NOME-GRANDE-AREA-DO-CONHECIMENTO']) cv.grandesAreas.push(a['NOME-GRANDE-AREA-DO-CONHECIMENTO']);
      if (a['NOME-DA-AREA-DO-CONHECIMENTO']) cv.areas.push(a['NOME-DA-AREA-DO-CONHECIMENTO']);
    }
  },
};
