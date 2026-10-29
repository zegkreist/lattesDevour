import { pool } from '../db.js';
import { norm } from '../util/text.js';

// Descoberta de IDs Lattes via ORCID (API pública, sem chave): busca registros pela
// afiliação e lê os links do perfil (researcher-urls) procurando lattes.cnpq.br/<16 dígitos>.
// Só cobre quem declarou o link no ORCID; a taxa de acerto varia por instituição.
const BASE = 'https://pub.orcid.org/v3.0';
const LATTES_RE = /lattes\.cnpq\.br\/(\d{16})/i;
const PAGE = 50;
const UA = 'lattesDevour/0.1 (descoberta de IDs Lattes por afiliação)';

async function getJson(url: string): Promise<any> {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (r.status === 429 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 1500 * (tentativa + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`ORCID ${r.status} em ${url}`);
    return r.json();
  }
  throw new Error(`ORCID indisponível: ${url}`);
}

export interface Candidato {
  orcid: string;
  nome: string;
  instituicoes: string[];
  lattesId: string | null;
}

export async function lattesDoOrcid(orcid: string): Promise<string | null> {
  const j = await getJson(`${BASE}/${orcid}/researcher-urls`);
  for (const u of j['researcher-url'] ?? []) {
    const m = LATTES_RE.exec(String(u?.url?.value ?? ''));
    if (m) return m[1];
  }
  return null;
}

async function pagina(query: string, start: number): Promise<{ total: number; itens: Candidato[] }> {
  const j = await getJson(`${BASE}/expanded-search/?q=${encodeURIComponent(query)}&start=${start}&rows=${PAGE}`);
  const itens: Candidato[] = (j['expanded-result'] ?? []).map((x: any) => ({
    orcid: x['orcid-id'],
    nome: [x['given-names'], x['family-names']].filter(Boolean).join(' '),
    instituicoes: x['institution-name'] ?? [],
    lattesId: null,
  }));
  // Perfis em paralelo limitado (a API pública aguenta ~24 req/s; ficamos bem abaixo).
  for (let i = 0; i < itens.length; i += 5) {
    await Promise.all(
      itens.slice(i, i + 5).map(async (it) => {
        it.lattesId = await lattesDoOrcid(it.orcid).catch(() => null);
      }),
    );
    await new Promise((r) => setTimeout(r, 250));
  }
  return { total: j['num-found'] ?? 0, itens };
}

const aspas = (s: string) => s.replace(/["\\]/g, ' ').trim();

/** Busca por nome (e instituição opcional) para o painel: devolve candidatos, sem gravar. */
export async function buscarPorNome(nome: string, instituicao?: string): Promise<Candidato[]> {
  let q = `"${aspas(nome)}"`;
  if (instituicao?.trim()) q += ` AND affiliation-org-name:"${aspas(instituicao)}"`;
  return (await pagina(q, 0)).itens;
}

let rodando = new Set<number>();
export const descobrindo = () => Array.from(rodando);

/** Varre uma instituição-alvo por completo (retomável pelo cursor). */
export async function descobrirInstituicao(alvoId: number, maxPaginas = Infinity): Promise<void> {
  if (rodando.has(alvoId)) return;
  rodando.add(alvoId);
  try {
    const a = (await pool.query('SELECT * FROM instituicao_alvo WHERE id=$1', [alvoId])).rows[0];
    if (!a) return;
    await pool.query(`UPDATE instituicao_alvo SET status='descobrindo', ultimo_erro=NULL, atualizado_em=now() WHERE id=$1`, [alvoId]);
    const query = `affiliation-org-name:"${aspas(a.nome)}"`;
    let cursor: number = a.descoberta_cursor;
    for (let n = 0; n < maxPaginas; n++) {
      const { total, itens } = await pagina(query, cursor);
      const achados = itens.filter((i) => i.lattesId);
      if (achados.length) {
        await pool.query(
          `INSERT INTO fila (lattes_id, origem, nome_hint, instituicao_alvo_id)
           SELECT x.id, 'orcid', x.nome, $1 FROM unnest($2::text[], $3::text[]) AS x(id, nome)
           ON CONFLICT (lattes_id) DO UPDATE SET instituicao_alvo_id = COALESCE(fila.instituicao_alvo_id, EXCLUDED.instituicao_alvo_id)`,
          [alvoId, achados.map((i) => i.lattesId), achados.map((i) => i.nome)],
        );
      }
      cursor += PAGE;
      const done = itens.length < PAGE || cursor >= total;
      await pool.query(
        `UPDATE instituicao_alvo SET descoberta_cursor=$2, descoberta_total=$3, descobertos=descobertos+$4,
           status=$5, atualizado_em=now() WHERE id=$1`,
        [alvoId, cursor, total, achados.length, done ? 'concluida' : 'descobrindo'],
      );
      if (done) return;
    }
  } catch (e) {
    await pool.query(`UPDATE instituicao_alvo SET status='erro', ultimo_erro=$2, atualizado_em=now() WHERE id=$1`, [
      alvoId,
      (e instanceof Error ? e.message : String(e)).slice(0, 400),
    ]);
  } finally {
    rodando.delete(alvoId);
  }
}

export async function adicionarAlvos(texto: string): Promise<number> {
  let n = 0;
  for (const linha of texto.split(/\r?\n/)) {
    const [nome, uf] = linha.split(/[;\t]/).map((s) => s.trim());
    if (!nome) continue;
    const r = await pool.query(
      `INSERT INTO instituicao_alvo (nome, nome_norm, uf) VALUES ($1,$2,$3) ON CONFLICT (nome_norm) DO NOTHING`,
      [nome, norm(nome), uf ? uf.toUpperCase().slice(0, 2) : null],
    );
    n += r.rowCount ?? 0;
  }
  return n;
}
