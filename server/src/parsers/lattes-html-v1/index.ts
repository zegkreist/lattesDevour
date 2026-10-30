import { HTMLElement, parse } from 'node-html-parser';
import { clean, norm, toInt, uniq } from '../../util/text.js';
import type { ParsedAutor, ParsedCV, ParsedObra, ParsedOrientacao } from '../types.js';

// Parser da página pública do CV (visualizacv.do), o que o coletor salva desde que o Lattes
// parou de servir o XML. Produz o mesmo ParsedCV do parser de XML, com os mesmos tipos de obra
// e a mesma chave (doi ou tipo|título|ano), para a obra de dois coautores virar uma só.
// A página é organizada em blocos h1 (title-wrapper); dentro deles, subtítulos (inst_back,
// cita-artigos), pares rótulo/valor (layout-cell-3 + layout-cell-9) e itens numerados
// (layout-cell-11). Como o XML, não lê nada pessoal além do que é profissional.

export const PARSER_ID = 'lattes-html-v1';
export const PARSER_VERSAO = 1;

// Subtítulo de produção (normalizado) -> tipo canônico (o mesmo do parser de XML).
const TIPO_POR_SECAO: [RegExp, string, string | null][] = [
  [/^artigos completos/, 'artigo', null],
  [/^artigos aceitos/, 'artigo_aceito', null],
  [/^livros publicados/, 'livro', null],
  [/^capitulos de livros/, 'capitulo', null],
  [/^textos em jornais/, 'texto_jornal', null],
  [/^trabalhos completos publicados em anais/, 'evento', 'COMPLETO'],
  [/^resumos expandidos/, 'evento', 'RESUMO_EXPANDIDO'],
  [/^resumos publicados/, 'evento', 'RESUMO'],
  [/^apresentacoes de trabalho/, 'apresentacao_de_trabalho', null],
  [/^outras producoes bibliograficas/, 'outra_producao_bibliografica', null],
  [/^softwares?/, 'software', null],
  [/^patentes?/, 'patente', null],
  [/^produtos tecnologicos/, 'produto_tecnologico', null],
  [/^processos ou tecnicas/, 'processo_tecnica', null],
  [/^trabalhos tecnicos/, 'trabalho_tecnico', null],
  [/^organizacao de eventos/, 'organizacao_de_evento', null],
];
// Subtítulos que não são lista de obras.
const SUBTITULOS_IGNORADOS = /^(citacoes|producao bibliografica|producao tecnica|producao artistica)/;

// Blocos h1 tratados; os demais conhecidos são ignorados de propósito (como DADOS-COMPLEMENTARES
// no XML). Bloco fora das duas listas vai para "desconhecidos".
const BLOCOS_TRATADOS = new Set([
  'identificacao', 'endereco', 'formacao academica titulacao', 'atuacao profissional',
  'areas de atuacao', 'producoes', 'eventos', 'orientacoes',
]);
const BLOCOS_IGNORADOS = new Set([
  '', 'formacao complementar', 'projetos de pesquisa', 'projetos de extensao', 'projetos de desenvolvimento',
  'outros projetos', 'idiomas', 'premios e titulos', 'bancas', 'linhas de pesquisa', 'membro de corpo editorial',
  'revisor de periodico', 'revisor de projeto de fomento', 'outras informacoes relevantes', 'inovacao',
  'educacao e popularizacao de c t', 'patentes e registros',
]);

const ANO_RE = /\b(19[4-9]\d|20\d\d)\b/g;

/** Texto do elemento com <br> como quebra de linha, em linhas limpas. */
function linhas(el: HTMLElement): string[] {
  return parse(el.innerHTML.replace(/<br[^>]*>/gi, '\n'))
    .text.split('\n')
    .map((l) => clean(l))
    .filter((l): l is string => !!l);
}

const semPonto = (s: string) => s.replace(/[\s.]+$/, '').trim();

function ultimoAno(s: string): number | null {
  const anos = [...s.matchAll(ANO_RE)].map((m) => Number(m[1])).filter((a) => a <= new Date().getFullYear() + 1);
  return anos.length ? anos[anos.length - 1] : null;
}

// "SILVA, I. A. ; VERDEJO, P. B. ; LAGO, S. N. A. . Título..." -> autores + resto.
// A lista de autores termina na primeira inicial seguida de outro ponto ("B.." ou "A. .").
const AUTORES_RE = /^(.+?\p{Lu}\.)\s?\.\s+(.+)$/su;

function separarAutores(texto: string): { autores: ParsedAutor[]; resto: string } {
  const m = AUTORES_RE.exec(texto);
  if (!m) return { autores: [], resto: texto };
  const autores = m[1]
    .split(';')
    .map((a) => clean(a))
    .filter((a): a is string => !!a)
    .map((nome, i) => ({ ordem: i + 1, nome, nomeCitacao: nome, lattesId: null }));
  return { autores, resto: m[2] };
}

interface Evento {
  bloco: string; // h1 normalizado
  inst: string | null; // inst_back
  sub: string | null; // cita-artigos
  el: HTMLElement;
  tipo: 'par' | 'item';
  rotulo?: string;
}

/** Percorre a página em ordem e emite pares rótulo/valor e itens numerados com seu contexto. */
function eventos(root: HTMLElement): { eventos: Evento[]; blocos: string[] } {
  const out: Evento[] = [];
  const blocos: string[] = [];
  let bloco = '';
  let inst: string | null = null;
  let sub: string | null = null;
  let rotulo: string | null = null;
  const visitar = (el: HTMLElement) => {
    for (const c of el.childNodes) {
      if (!(c instanceof HTMLElement)) continue;
      const cls = c.classList;
      if (c.tagName === 'H1' && c.closest('.title-wrapper')) {
        bloco = norm(c.text);
        blocos.push(bloco);
        inst = sub = rotulo = null;
        continue;
      }
      if (cls.contains('inst_back')) {
        inst = clean(c.text);
        sub = null;
        continue;
      }
      if (cls.contains('cita-artigos')) {
        sub = clean(c.text);
        continue;
      }
      if (cls.contains('layout-cell-3')) {
        rotulo = clean(c.text);
        continue;
      }
      if (cls.contains('layout-cell-9')) {
        out.push({ bloco, inst, sub, el: c, tipo: 'par', rotulo: rotulo ?? '' });
        rotulo = null;
        continue;
      }
      if (cls.contains('layout-cell-11')) {
        out.push({ bloco, inst, sub, el: c, tipo: 'item' });
        continue;
      }
      visitar(c);
    }
  };
  visitar(root);
  return { eventos: out, blocos };
}

function obra(ev: Evento, cv: ParsedCV): ParsedObra | null {
  const sub = norm(ev.sub ?? ev.inst ?? '');
  if (SUBTITULOS_IGNORADOS.test(sub)) return null;
  const achado = TIPO_POR_SECAO.find(([re]) => re.test(sub));
  let tipo = achado?.[1];
  if (!tipo) {
    tipo = sub.replace(/ /g, '_') || 'desconhecido';
    cv.avisos.push(`tipo de produção sem mapeamento: "${ev.sub ?? ev.inst}" (gravado como ${tipo})`);
  }
  const span = ev.el.querySelector('.transform') ?? ev.el;
  // Artigos trazem metadados estruturados no cvuri do contador de citações.
  const cvuri = span.querySelector('.citado')?.getAttribute('cvuri');
  const meta = cvuri?.includes('?') ? new URLSearchParams(cvuri.slice(cvuri.indexOf('?') + 1)) : null;
  const anoSpan = toInt(span.querySelector('[data-tipo-ordenacao="ano"]')?.text);
  const doiHref = span.querySelector('a.icone-doi')?.getAttribute('href') ?? meta?.get('doi') ?? null;
  for (const s of span.querySelectorAll('.informacao-artigo, .citado')) s.remove();
  const texto = clean(span.text);
  if (!texto) return null;

  const { autores, resto } = separarAutores(texto);
  let titulo: string | null = null;
  let veiculo: string | null = clean(meta?.get('nomePeriodico'));
  const subtipoParen = /\(([^()]+)\)\s*\.?\s*$/.exec(resto)?.[1] ?? null;
  if (meta) {
    // O título do texto é mais fiel (o cvuri troca aspas por "¿"); o do cvuri é a reserva.
    const fimTitulo = veiculo ? resto.indexOf(`. ${veiculo}`) : -1;
    titulo = fimTitulo > 0 ? resto.slice(0, fimTitulo) : clean(meta.get('titulo'));
  }
  if (!titulo) {
    const emIn = resto.indexOf('. In: ');
    const comAno = /^(.*?)\.\s*(?:19|20)\d\d\.\s*\(/s.exec(resto);
    if (emIn > 0) {
      titulo = resto.slice(0, emIn);
      const depois = resto.slice(emIn + 6);
      // Capítulo: "In: Org. (Org.). Título do livro. ..."; anais: "In: Nome do evento, 2018, ..."
      veiculo = clean(/\(Orgs?\.\)\.\s*([^.]+)/.exec(depois)?.[1]) ?? clean(depois.split(/[,.]/)[0]);
    } else if (comAno) {
      titulo = comAno[1];
    } else {
      titulo = resto.split(/\.\s/)[0];
    }
  }
  titulo = titulo ? semPonto(titulo) : null;
  if (!titulo) return null;
  const ano = anoSpan ?? ultimoAno(resto);
  const doi = doiHref ? doiHref.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() : null;
  // Natureza no formato do XML: "Comunicação" -> "COMUNICACAO".
  const natureza = subtipoParen ? norm(subtipoParen.split('/').pop()).toUpperCase().replace(/ /g, '_') : null;
  const subtipo = achado?.[2] ?? natureza;
  const posTitulo = resto.indexOf(titulo);
  const depoisTitulo = posTitulo >= 0 ? resto.slice(posTitulo + titulo.length).replace(/^[\s.]+/, '') : '';

  return {
    chave: doi ? `doi:${doi}` : `${tipo}|${norm(titulo)}|${ano ?? ''}`,
    tipo,
    subtipo,
    titulo,
    ano,
    doi,
    idioma: null,
    veiculo,
    issn: clean(meta?.get('issn')),
    isbn: null,
    pais: null,
    palavrasChave: [],
    grandesAreas: [],
    areas: [],
    autores,
    dados: detalhes(tipo, depoisTitulo, { veiculo, ano, subtipo, issn: clean(meta?.get('issn')), volume: clean(meta?.get('volume')), texto }),
  };
}

// Campo -> valor, só os presentes.
function semVazios(d: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(d).filter((e): e is [string, string] => !!e[1]));
}

/**
 * Detalhes que a página só mostra no texto da citação (ABNT), com os MESMOS nomes de atributo do
 * XML do Lattes, para que consultas em obra.dados valham para as duas fontes. CITACAO guarda o
 * texto original. "depois" é o que vem depois do título.
 */
function detalhes(
  tipo: string,
  depois: string,
  o: { veiculo: string | null; ano: number | null; subtipo: string | null; issn: string | null; volume: string | null; texto: string },
): Record<string, string> {
  const pag = /\bp\.\s*(\w+)\s*-\s*(\w+)/.exec(depois);
  const volume = o.volume ?? /\bv\.\s*([^,.\s]+)/.exec(depois)?.[1];
  const fasciculo = /\bn\.\s*([^,.\s]+)/.exec(depois)?.[1];
  // "1ed.Goiânia: Redelp, 2024" / "1. ed. São Paulo: Editora, 2020" / "Goiânia: Gráfica UFG, 2018".
  // A cidade começa depois de um ponto e é curta: evita "In: ..." e títulos com dois-pontos.
  const ed = [...depois.matchAll(/(?:^|\.\s*)(?:(\d+)\s*\.?\s*ed\.?\s*)?(?!In:)([^.:;\d]+?):\s*([^,:]+),\s*(?:19|20)\d\d/g)]
    .find((m) => m[2].trim().split(/\s+/).length <= 5);
  const editora = { 'NUMERO-DA-EDICAO-REVISAO': ed?.[1], 'CIDADE-DA-EDITORA': clean(ed?.[2]), 'NOME-DA-EDITORA': clean(ed?.[3]) };
  const comum = { CITACAO: o.texto, 'PAGINA-INICIAL': pag?.[1], 'PAGINA-FINAL': pag?.[2] };
  const anoTxt = o.ano ? String(o.ano) : null;
  switch (tipo) {
    case 'artigo':
    case 'artigo_aceito':
      return semVazios({ ...comum, 'TITULO-DO-PERIODICO-OU-REVISTA': o.veiculo, ISSN: o.issn, VOLUME: volume, FASCICULO: fasciculo, 'ANO-DO-ARTIGO': anoTxt });
    case 'capitulo': {
      // "In: Org1; Org2. (Org.). Título do livro. ..."
      const orgs = /^In:\s*(.+?)\.\s*\(Orgs?\.\)/.exec(depois)?.[1];
      return semVazios({ ...comum, ...editora, ORGANIZADORES: clean(orgs), 'TITULO-DO-LIVRO': o.veiculo, VOLUME: volume, 'ANO': anoTxt });
    }
    case 'livro': {
      const paginas = /(\d+)\s*p\.?\s*$/.exec(depois.replace(/[\s.]+$/, ''))?.[1];
      return semVazios({ CITACAO: o.texto, ...editora, 'NUMERO-DE-PAGINAS': paginas, VOLUME: volume, ANO: anoTxt });
    }
    case 'evento': {
      // "In: Nome do evento, 2018, Goiânia. Título dos anais. Cidade: Editora, 2018. v. 1. p. 233-273."
      const ev = /^In:\s*(.+?),\s*((?:19|20)\d\d)(?:,\s*([^.]+))?\.\s*(.*)$/s.exec(depois);
      const anais = ev ? clean(ev[4].split(/\.\s/)[0].replace(/,\s*(?:19|20)\d\d\.?$/, '')) : null;
      return semVazios({
        ...comum, ...editora, NATUREZA: o.subtipo, 'NOME-DO-EVENTO': clean(ev?.[1]) ?? o.veiculo, 'ANO-DE-REALIZACAO': ev?.[2],
        'CIDADE-DO-EVENTO': clean(ev?.[3]), 'TITULO-DOS-ANAIS-OU-PROCEEDINGS': anais ? semPonto(anais) : null, VOLUME: volume, 'ANO-DO-TRABALHO': anoTxt,
      });
    }
    default:
      return semVazios({ ...comum, NATUREZA: o.subtipo, ANO: anoTxt });
  }
}

function nivelOrientacao(sub: string): ParsedOrientacao['nivel'] {
  const s = norm(sub);
  if (s.includes('pos doutorado')) return 'pos_doutorado';
  if (s.includes('doutorado')) return 'doutorado';
  if (s.includes('mestrado')) return 'mestrado';
  return 'outras';
}

// "NOME. Título. 2026. Tipo (Curso) - Instituição. Orientador: X."
const ORIENTACAO_RE = /^(.+?)\.\s+(.+?)\.\s+((?:19|20)\d\d)\.\s+(.+)$/s;

function orientacao(ev: Evento): ParsedOrientacao | null {
  const texto = clean(ev.el.text);
  const m = texto ? ORIENTACAO_RE.exec(texto) : null;
  if (!m) return null;
  const [, nome, titulo, ano, resto] = m;
  const id = /lattes\.cnpq\.br\/(\d{16})/.exec(ev.el.querySelector('a[href*="lattes.cnpq.br/"]')?.getAttribute('href') ?? '')?.[1];
  // O " - " que separa a instituição; o de dentro dos parênteses (curso) não conta.
  const inst = /\s-\s(.+?)(?:\.\s*(?:Orientador|Coorientador|Supervisor)|\.?\s*$)/s.exec(resto.replace(/\([^()]*\)/g, ''))?.[1];
  return {
    nivel: nivelOrientacao(ev.sub ?? ''),
    orientadoNome: nome.trim(),
    orientadoLattesId: id ?? null,
    titulo: semPonto(titulo),
    ano: Number(ano),
    instituicao: inst ? (clean(inst.split(',')[0]) ?? null) : null,
    curso: clean(/\(([^()]+)\)/.exec(resto)?.[1]),
  };
}

const NIVEIS_FORMACAO: [RegExp, string][] = [
  [/^pos doutorado/, 'pos_doutorado'],
  [/^livre docencia/, 'livre_docencia'],
  [/^doutorado/, 'doutorado'],
  [/^mestrado profissional/, 'mestrado_profissionalizante'],
  [/^mestrado/, 'mestrado'],
  [/^especializacao/, 'especializacao'],
  [/^aperfeicoamento/, 'aperfeicoamento'],
  [/^residencia/, 'residencia_medica'],
  [/^graduacao/, 'graduacao'],
  [/^ensino medio/, 'ensino_medio_segundo_grau'],
  [/^curso tecnico/, 'curso_tecnico_profissionalizante'],
];

function periodo(rotulo: string): { inicio: number | null; fim: number | null } {
  const anos = [...rotulo.matchAll(ANO_RE)].map((m) => Number(m[1]));
  return { inicio: anos[0] ?? null, fim: /atual/i.test(rotulo) ? null : (anos[1] ?? anos[0] ?? null) };
}

/** "Universidade Federal de Goiás, UFG, Brasil." -> { nome, pais } */
function instituicaoDeLinha(linha: string): { nome: string; pais: string | null } {
  const partes = semPonto(linha).split(',').map((p) => p.trim()).filter(Boolean);
  return { nome: partes[0] ?? linha, pais: partes.length > 1 ? partes[partes.length - 1] : null };
}

/**
 * Outros pesquisadores com link para o próprio Lattes na página (orientador, orientados,
 * coautores, membros de banca): o ícone do Lattes vem seguido do nome.
 */
function vinculados(root: HTMLElement, dono: string): { lattesId: string; nome: string | null }[] {
  const porId = new Map<string, string | null>();
  for (const a of root.querySelectorAll('a[href*="lattes.cnpq.br/"]')) {
    const id = /lattes\.cnpq\.br\/(\d{16})/.exec(a.getAttribute('href') ?? '')?.[1];
    if (!id || id === dono) continue;
    const irmaos = a.parentNode?.childNodes ?? [];
    const seguinte = irmaos[irmaos.indexOf(a) + 1];
    const nome = seguinte ? clean(semPonto(seguinte.text.split(/[.;(]/)[0])) : null;
    if (!porId.get(id)) porId.set(id, nome);
  }
  return [...porId].map(([lattesId, nome]) => ({ lattesId, nome }));
}

export function parseHtmlCV(html: string): ParsedCV {
  const root = parse(html);
  const cv: ParsedCV = {
    lattesId: '',
    nome: clean(root.querySelector('.infpessoa h2.nome')?.text) ?? '',
    nomesCitacao: [],
    orcid: null,
    resumo: null,
    dataAtualizacao: null,
    instituicao: null,
    grandesAreas: [],
    areas: [],
    formacao: [],
    atuacoes: [],
    obras: [],
    orientacoes: [],
    desconhecidos: [],
    avisos: [],
  };
  const info = root.querySelector('.informacoes-autor')?.text ?? '';
  cv.lattesId = /ID Lattes:\s*(\d{16})/.exec(info)?.[1] ?? /lattes\.cnpq\.br\/(\d{16})/.exec(info)?.[1] ?? '';
  const d = /atualiza[çc][ãa]o do curr[íi]culo em (\d{2})\/(\d{2})\/(\d{4})/i.exec(info);
  if (d) cv.dataAtualizacao = `${d[3]}-${d[2]}-${d[1]}`;
  const resumo = root.querySelector('p.resumo');
  if (resumo) {
    resumo.querySelectorAll('span.texto').forEach((s) => s.remove());
    cv.resumo = clean(resumo.text);
  }

  const { eventos: evs, blocos } = eventos(root.querySelector('.main-content') ?? root);
  for (const b of uniq(blocos)) {
    if (!BLOCOS_TRATADOS.has(b) && !BLOCOS_IGNORADOS.has(b)) cv.desconhecidos.push(`html:${b}`);
  }

  let atuacaoInst: string | null = null;
  let instAtual: { nome: string; pais: string | null } | null = null;
  for (const ev of evs) {
    const rot = norm(ev.rotulo);
    if (ev.bloco === 'identificacao' && ev.tipo === 'par') {
      const valor = clean(ev.el.text) ?? '';
      if (rot.startsWith('nome em citacoes')) {
        cv.nomesCitacao = valor.split(';').map((s) => clean(s)).filter((s): s is string => !!s);
      }
      const orcid = /orcid\.org\/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i.exec(ev.el.innerHTML)?.[1];
      if (orcid) cv.orcid = orcid;
    } else if (ev.bloco === 'endereco' && ev.tipo === 'par' && rot.startsWith('endereco profissional')) {
      const ls = linhas(ev.el);
      const local = ls.map((l) => /-\s*([^,-]+),\s*([A-Z]{2})\s*-\s*([^.]+)/.exec(l)).find(Boolean);
      if (ls[0]) {
        cv.instituicao = {
          codigo: null,
          nome: instituicaoDeLinha(ls[0]).nome,
          uf: local?.[2] ?? null,
          cidade: clean(local?.[1]),
          pais: clean(local?.[3]),
        };
      }
    } else if (ev.bloco === 'formacao academica titulacao' && ev.tipo === 'par') {
      const ls = linhas(ev.el);
      if (!ls[0]) continue;
      const cab = norm(ls[0]);
      const titulo = ls.find((l) => l.startsWith('Título:'));
      const orientador = ls.find((l) => /^Orientador/.test(l));
      cv.formacao.push({
        nivel: NIVEIS_FORMACAO.find(([re]) => re.test(cab))?.[1] ?? cab.split(' ')[0],
        instituicao: ls[1] ? instituicaoDeLinha(ls[1]).nome : null,
        curso: clean(semPonto(ls[0]).split(/ em (?:andamento em )?/)[1]),
        ...periodo(ev.rotulo ?? ''),
        ...(cab.includes('em andamento') ? { fim: null } : {}),
        titulo: titulo ? clean(titulo.replace(/^Título:\s*/, '').replace(/,\s*Ano de Obten[çc][ãa]o:.*$/, '').replace(/\.$/, '')) : null,
        orientador: orientador ? clean(semPonto(orientador.replace(/^Orientador[^:]*:\s*/, ''))) : null,
      });
    } else if (ev.bloco === 'atuacao profissional' && ev.tipo === 'par') {
      // Um registro por instituição, com o vínculo mais recente (o primeiro listado).
      if (!ev.inst || ev.inst === atuacaoInst) continue;
      const v = /V[íi]nculo:\s*([^,]+)(?:,\s*Enquadramento Funcional:\s*([^,]+))?/.exec(ev.el.text);
      if (!v) continue;
      atuacaoInst = ev.inst;
      const p = periodo(ev.rotulo ?? '');
      const inst = instituicaoDeLinha(ev.inst);
      cv.atuacoes.push({ instituicao: inst.nome, vinculo: clean(v[1]), enquadramento: clean(v[2]), ...p });
      if (p.fim === null && !instAtual) instAtual = inst;
    } else if (ev.bloco === 'areas de atuacao' && ev.tipo === 'par') {
      const t = ev.el.text;
      const g = /Grande [áa]rea:\s*([^/]+)/i.exec(t)?.[1];
      const a = /(?:^|\/)\s*[ÁA]rea:\s*([^/]+)/i.exec(t)?.[1];
      if (g) cv.grandesAreas.push(semPonto(g));
      if (a) cv.areas.push(semPonto(a));
    } else if ((ev.bloco === 'producoes' || ev.bloco === 'eventos') && ev.tipo === 'item') {
      if (ev.bloco === 'eventos' && !/^organizacao/.test(norm(ev.inst))) continue; // participação: ignorada, como no XML
      const o = obra(ev, cv);
      if (o) cv.obras.push(o);
    } else if (ev.bloco === 'orientacoes' && ev.tipo === 'item') {
      if (!/conclu/.test(norm(ev.inst))) continue; // em andamento: o XML também não extrai
      const o = orientacao(ev);
      if (o) cv.orientacoes.push(o);
      else cv.avisos.push(`orientação não reconhecida: ${clean(ev.el.text)?.slice(0, 80)}`);
    }
  }

  if (!cv.instituicao) {
    // Sem endereço profissional publicado: usa a instituição do vínculo atual (sem UF).
    if (instAtual) cv.instituicao = { codigo: null, nome: instAtual.nome, uf: null, cidade: null, pais: instAtual.pais };
    cv.avisos.push('sem endereço profissional');
  }
  cv.vinculados = vinculados(root, cv.lattesId);
  cv.grandesAreas = uniq(cv.grandesAreas);
  cv.areas = uniq(cv.areas);
  if (!/^\d{16}$/.test(cv.lattesId)) throw new Error(`ID Lattes não encontrado na página ("${cv.lattesId}")`);
  if (!cv.nome) throw new Error('página sem nome do pesquisador');
  return cv;
}
