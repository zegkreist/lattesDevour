# Lattes Devour

Coleta currículos Lattes, guarda o arquivo cru em disco, converte em tabelas num PostgreSQL
(pesquisadores, obras, autorias, orientações) e serve um painel com busca por região, tema,
título, instituição e tags, mais um grafo de colaboradores e obras.

Baseado no **[scriptLattes](https://github.com/jpmenachalco/scriptLattes)**, de Jesús P. Mena-Chalco
e Roberto M. Cesar Jr., mas guardando num banco em vez de gerar um site estático
(veja [Créditos](#créditos)).

```
 navegador ──► app (Node/TS)  ── API + front + coletor (Chromium) + parse + backup
                 │   └── noVNC :6080  (o navegador do coletor, para resolver captcha)
                 └──► db (Postgres 17)
   host:  ./data/pg  (banco)   ./data/app  (xml/, html/, import/, backups/, exports/, browser-profile/)
```

**Neste guia:** [Instalação](#instalação) · [Primeiro uso](#primeiro-uso) ·
[Atualizar e mover](#atualizar-parar-e-mover) · [Problemas comuns](#problemas-comuns) ·
[Colocar online num domínio](#colocar-online-num-domínio)

## Instalação

**Você precisa de:** Docker com Compose v2 (`docker compose version` tem de responder) e internet
de saída. Como referência, reserve 2 CPUs e 4 GB de RAM, por causa do Chromium e do Postgres. O disco
cresce com a base. A imagem pronta do Docker Hub é só `amd64`.

### 1. Baixar e configurar

```bash
git clone https://github.com/zegkreist/lattesDevour.git
cd lattesDevour
cp .env.example .env

# Senhas e dono dos arquivos em ./data/app
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
sed -i "s/^VNC_PASSWORD=.*/VNC_PASSWORD=$(openssl rand -hex 4)/" .env
sed -i "s/^LATTES_UID=.*/LATTES_UID=$(id -u)/; s/^LATTES_GID=.*/LATTES_GID=$(id -g)/" .env
```

Guarde o `.env`. Três cuidados com as senhas:

- **`POSTGRES_PASSWORD` só vale na primeira inicialização do banco.** Trocar depois exige o passo
  descrito em [Problemas comuns](#problemas-comuns).
- **Evite `@`, `:` e `/` nela**, porque a senha entra numa URL de conexão. O comando acima gera só
  letras e números. Essa mesma senha é pedida para apagar o banco pelo painel.
- **O VNC só usa os 8 primeiros caracteres** de `VNC_PASSWORD`, por isso o comando gera 8.

### 2. Subir

```bash
docker compose up -d --build
```

O primeiro build baixa o Chromium e leva alguns minutos. As tabelas são criadas sozinhas quando o app
sobe.

### 3. Conferir

```bash
docker compose ps                              # app e db em "running"
curl -s http://localhost:8080/api/coletor      # responde um JSON com "rodando"
docker compose logs -f app                     # acompanha o log, se algo falhar
```

| O quê | Onde |
|---|---|
| Painel | <http://localhost:8080> |
| Navegador do coletor (noVNC) | <http://localhost:6080/vnc.html?autoconnect=true&resize=scale> |
| Seus dados | `./data` (sobrevive a `docker compose down`) |

As portas só escutam em `127.0.0.1`. Num servidor remoto, veja
[Colocar online num domínio](#colocar-online-num-domínio).

### Outras formas de instalar

#### Container único

Postgres e app num container só, sem precisar de Compose para rodar:

```bash
./single.sh                                 # build local
./single.sh zegkreist/lattesdevour:latest   # usa a imagem do Docker Hub
./single.sh --stop
```

Usa os mesmos `./data/app` e `./data/pg` do Compose (o Postgres roda como uid 999 e locale
`en_US.UTF-8`, como na imagem oficial), por isso o script derruba o Compose antes de subir: os dois
nunca podem abrir o banco ao mesmo tempo. Cria o `.env` se não existir. A imagem é o estágio `single`
do `Dockerfile`; o Compose usa o estágio `app`. Para publicar no Docker Hub há um `build-and-push.sh`
local (fora do git, contém credenciais).

> O `single.sh` fixa o link do noVNC em `localhost`. Para publicar num domínio, use o Compose.

#### ZimaOS / CasaOS

1. Publique a imagem: `./build-and-push.sh` (gera `zegkreist/lattesdevour:latest`, amd64).
2. No ZimaOS: App Store → “+” → Instalar app personalizado → Importar → cole
   [`zimaos/docker-compose.yml`](zimaos/docker-compose.yml), **trocando as duas senhas**.
3. Painel em `http://<ip-do-zima>:8080`. O link do noVNC no painel aponta para o mesmo host, porta 6080
   (defina `NOVNC_URL` se mapear outra porta). Ritmo e caminho ficam na aba Coleta; a chave do 2Captcha,
   em Configurações.

Dados em `/media/firstBlood/lattesdevour/{app,pg}` (ajuste no compose se usar outro disco). Diferente
do setup local, as portas ficam abertas na rede de casa e o painel não tem login: **não encaminhe
essas portas no roteador**. Para acessar de fora, use o
[Cloudflare Tunnel](#opção-b-cloudflare-tunnel-sem-abrir-portas). Para atualizar: publique de novo e
faça pull/recreate do app.

## Primeiro uso

1. **Coleta → Adicionar CVs:** cole um link (`lattes.cnpq.br/<ID>`) ou um ID de 16 dígitos e clique em
   **Adicionar**.
2. **Coleta → Coletor:** escolha o caminho de download. “Prévia da busca” usa captcha invisível; “Link
   direto” pede o captcha resolvido por você no noVNC ou pelo 2Captcha (chave em Configurações).
3. Clique em **Iniciar**. Nada é baixado até isso. A seção [Captcha](#captcha-leia-isto) explica as
   opções e os limites.
4. Com o CV parseado, ele aparece em **Busca**, **Grafo** e **Painel**.

## Atualizar, parar e mover

```bash
git pull && docker compose up -d --build     # atualizar (as migrações rodam sozinhas)
docker compose down                          # parar (os dados ficam em ./data)
```

**Mudar de servidor:** pare o app e copie `data/` e `.env` preservando os donos dos arquivos (o banco
pertence a outro usuário, por isso o `sudo`):

```bash
docker compose down
sudo tar czpf lattes.tgz data .env           # no servidor antigo
sudo tar xzpf lattes.tgz                     # no novo, dentro da pasta do projeto
```

Sobre cópias periódicas, veja [Backup](#backup).

## Problemas comuns

| Sintoma | Causa e solução |
|---|---|
| `port is already allocated` | Outra coisa usa a porta. Mude `APP_PORT` ou `NOVNC_PORT` no `.env`. Se mudar a do noVNC, ajuste também `NOVNC_URL`. |
| `password authentication failed` no log | O `.env` mudou depois que o banco foi criado. Volte a senha antiga ou aplique a nova: `docker compose exec db psql -U lattes -d lattes -c "ALTER ROLE lattes PASSWORD 'senha-do-env'"`. |
| Erro de URL inválida ao conectar no banco | A senha tem `@`, `:` ou `/`. Use só letras e números. |
| `permission denied` em `./data/app` | Confira `LATTES_UID` e `LATTES_GID` no `.env` (`id -u`; `id -g`) e recrie o container. |
| Link do noVNC abre `localhost` ou porta errada | Defina `NOVNC_URL` no `.env` e rode `docker compose up -d`. |
| Coleta para em “pausado” ou “aguardando captcha” | É esperado. Resolva pelo noVNC ou revise o 2Captcha, conforme a mensagem na aba Coleta. Veja [Captcha](#captcha-leia-isto). |
| Próximos sempre vazia, ou telas antigas | A imagem está velha: `docker compose up -d --build`. |

## Colocar online num domínio

> ⚠️ **O painel não tem login.** Quem chega nele pode mexer na fila, iniciar a coleta e trocar
> configurações, e o noVNC dá controle do navegador do coletor. **Nunca publique as portas 8080 e 6080
> diretamente:** coloque sempre um login na frente, como nas opções abaixo. Esse login é único para
> todos, sem perfis, então só compartilhe com quem pode operar tudo.

| Sua situação | Caminho |
|---|---|
| Servidor com IP público (VPS) e domínio | [A. Caddy](#opção-a-caddy-https-automático-e-senha) |
| Casa, NAS, operadora com CGNAT, ou prefere não abrir portas | [B. Cloudflare Tunnel](#opção-b-cloudflare-tunnel-sem-abrir-portas) |
| Só você ou um grupo pequeno, sem domínio | [C. SSH ou Tailscale](#opção-c-sem-dns-público-ssh-ou-tailscale) |

**Preparação comum às opções A e B:**

- **Domínio:** qualquer registrador serve (para `.br`, o [Registro.br](https://registro.br)).
- **Nomes:** os exemplos usam `lattes.exemplo.com.br` (painel) e `lattes-vnc.exemplo.com.br` (noVNC).
  Prefira nomes de um nível só: o certificado gratuito da Cloudflare não cobre `vnc.lattes.exemplo.com.br`.
- **Link do noVNC:** acrescente ao `.env` e aplique com `docker compose up -d` (as aspas são necessárias):

  ```bash
  NOVNC_URL='https://lattes-vnc.exemplo.com.br/vnc.html?autoconnect=true&resize=scale'
  ```

- **noVNC é opcional:** se usa 2Captcha ou a prévia e raramente precisa dele, deixe-o fora do domínio e
  abra por túnel SSH quando precisar ([opção C](#opção-c-sem-dns-público-ssh-ou-tailscale)). É menos uma
  porta de entrada.

### Opção A: Caddy (HTTPS automático e senha)

O [Caddy](https://caddyserver.com/docs/install) roda na própria máquina, emite o certificado sozinho e
repassa para as portas locais do app. Requer Caddy 2.8 ou mais novo.

**1. DNS.** No painel do domínio, crie os registros abaixo e espere propagar **antes** de iniciar o Caddy:

| Tipo | Nome | Valor | TTL |
|---|---|---|---|
| A | `lattes` | IP público do servidor | 300 |
| A | `lattes-vnc` | IP público do servidor | 300 |

```bash
dig +short lattes.exemplo.com.br      # tem de responder o IP do servidor
```

Se o servidor tem IPv6, crie também registros `AAAA`. Se usa o proxy da Cloudflare (nuvem laranja),
coloque o SSL em “Full (strict)”; é mais simples começar com “DNS only” (nuvem cinza).

**2. Firewall.** Abra só SSH, 80 e 443. As portas 8080 e 6080 do Compose já escutam apenas em
`127.0.0.1`.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

**3. Senha.** Gere o hash; o Caddy não aceita senha em texto puro:

```bash
caddy hash-password
```

**4. `/etc/caddy/Caddyfile`:**

```caddyfile
(login) {
	basic_auth {
		admin HASH_GERADO_NO_PASSO_3
	}
}

lattes.exemplo.com.br {
	import login
	reverse_proxy localhost:8080
}

lattes-vnc.exemplo.com.br {
	import login
	reverse_proxy localhost:6080
}
```

```bash
sudo systemctl reload caddy
```

O WebSocket do noVNC passa pelo `reverse_proxy` sem configuração extra.

**IP de casa que muda?** Use um DNS dinâmico (DuckDNS ou o do seu provedor) e encaminhe as portas 80 e
443 do roteador para a máquina. Antes, veja se a operadora usa CGNAT: compare o IP WAN do roteador com
`curl ifconfig.me`. Se forem diferentes, ou se o WAN estiver em `100.64.x.x`, não há como receber
conexões de fora: use a opção B.

### Opção B: Cloudflare Tunnel (sem abrir portas)

A máquina abre uma conexão de saída para a Cloudflare, então funciona atrás de CGNAT e não expõe seu
IP. O domínio precisa usar os nameservers da Cloudflare, e o plano gratuito atende esse uso.

**1. Crie o login primeiro.** Sem isso, o endereço fica aberto para qualquer pessoa. No
[painel Zero Trust](https://one.dash.cloudflare.com): *Access controls → Applications → Create new
application → Self-hosted and private*. Crie uma aplicação para cada nome, com uma política que permita
só os e-mails autorizados. O acesso por código enviado ao e-mail (one-time PIN) não exige configurar
provedor de login.

**2. Crie o túnel.** Com o
[`cloudflared`](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)
instalado:

```bash
cloudflared tunnel login
cloudflared tunnel create lattes                 # mostra o UUID e cria o arquivo de credenciais
cloudflared tunnel route dns lattes lattes.exemplo.com.br
cloudflared tunnel route dns lattes lattes-vnc.exemplo.com.br
```

Os registros DNS são criados por esses comandos.

**3. `~/.cloudflared/config.yml`:**

```yaml
tunnel: <UUID>
credentials-file: /home/<usuario>/.cloudflared/<UUID>.json

ingress:
  - hostname: lattes.exemplo.com.br
    service: http://localhost:8080
  - hostname: lattes-vnc.exemplo.com.br
    service: http://localhost:6080
  - service: http_status:404      # obrigatório: regra final sem hostname
```

No ZimaOS ou com o `cloudflared` em outra máquina da rede, troque `localhost` pelo IP do NAS. No
ZimaOS, defina também `NOVNC_URL` em `environment` do compose.

**4. Teste e deixe como serviço:**

```bash
cloudflared tunnel ingress validate
cloudflared tunnel run lattes                    # teste; Ctrl+C para sair
sudo cloudflared --config /home/<usuario>/.cloudflared/config.yml service install
sudo systemctl start cloudflared
```

### Opção C: sem DNS público (SSH ou Tailscale)

**Túnel SSH:** o mais simples para um servidor remoto. Não publica nada, e os links de `localhost`
funcionam enquanto a conexão estiver aberta:

```bash
ssh -L 8080:localhost:8080 -L 6080:localhost:6080 usuario@servidor
```

**[Tailscale](https://tailscale.com/kb/1242/tailscale-serve):** dá HTTPS e um nome
`<maquina>.<sua-rede>.ts.net`, visível só para os aparelhos da sua rede Tailscale:

```bash
sudo tailscale serve --bg localhost:8080
sudo tailscale serve --bg --https=8443 localhost:6080
```

Nesse caso, use `NOVNC_URL='https://<maquina>.<sua-rede>.ts.net:8443/vnc.html?autoconnect=true&resize=scale'`.
A documentação do Tailscale não menciona WebSocket: se o noVNC não conectar, use o túnel SSH para ele.

### Antes de divulgar o endereço

- [ ] Numa aba anônima, o endereço pede login antes de mostrar qualquer coisa.
- [ ] A API também está protegida: `curl -I https://lattes.exemplo.com.br/api/coletor` responde `401`
      (Caddy) ou redireciona para o login (Cloudflare), nunca `200`.
- [ ] De fora da rede, as portas 8080 e 6080 não respondem (`nmap -Pn -p 8080,6080 <ip-publico>`).
- [ ] Na aba Coleta, o botão noVNC abre o domínio certo, e a tela conecta.
- [ ] `VNC_PASSWORD` está definida, e o `.env` não foi para o git.
- [ ] O backup está ligado e copia para fora da máquina (`BACKUP_S3_BUCKET`).
- [ ] Você decidiu o que expor e como atender pedidos de remoção (LGPD): o painel mostra nomes,
      vínculos e produção de pessoas reais. Ver [Banco](#banco).

> As configurações de Caddy, Cloudflare e Tailscale seguem a documentação oficial (conferida em
> 2026-11), mas ainda não foram executadas com este projeto. Se algo divergir, vale o que diz a
> documentação de cada ferramenta.

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
| Próximos da rede | aba Próximos → filtro (região, instituição, tema, nome) escolhe a rede de quem já foi coletado; lista quem **ainda não foi coletado** e é coautor/orientado dela, por quantos da rede o citam; marque e mande para o topo (com rede) ou fim da fila | quem tem Lattes linkado nos CVs já coletados |
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
- **Coleta da rede:** os links `lattes.cnpq.br/<id>` de outra pessoa na página (orientador,
  orientados, coautores) só entram na fila quando o CV foi pedido com rede (“topo + rede”), até o
  nível pedido, contado a partir da lista enviada; CVs de fora da rede não puxam vizinhos. Entram
  com origem `cv` e o nome como dica; quem já estava na fila não duplica. Quem é citado e ainda
  não foi coletado aparece na aba Próximos.
- Os XMLs e HTMLs crus ficam em `data/app/xml/` e `data/app/html/`, então **trocar um parser não
  exige baixar de novo**: Configurações → “Reprocessar todos” repassa todo XML/HTML em disco,
  inclusive arquivos soltos em `data/app/html/` (ex.: salvos à mão do navegador).
- Amostras reais de HTML em `data/amostras/<id>.html` (fora do git) entram num teste que exige
  parse sem erro, sem seção desconhecida e toda obra com autor e ano.
- **Pegar amostras para um parser novo:** no Painel, card “Elementos sem parser”, clique
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

- Coleta nominal exige captcha (humano ou 2Captcha, acima).
- UF/região de quem não publica “Endereço profissional” é **inferida** pela instituição: a atual e, depois, as da formação (em andamento, depois a mais recente). Vale a UF já conhecida no banco para aquela instituição (aprendida do endereço de outro CV) ou a deduzida do nome (sigla: “USP”, “UFG”, “PUC-SP”; estado: “Universidade Federal de Goiás”). O log de parse registra “UF X inferida pela instituição Y”; quando uma instituição ganha UF, quem estava ligado a ela sem UF volta para o parse. Instituição sem pista nenhuma (“Universidade Candido Mendes”) não é adivinhada.
- O parser de HTML foi validado em 8 CVs reais (Letras, Comunicação, Psicologia, Imunologia, Tradução/Libras, Museologia); áreas com produção muito diferente (patentes, software, produção artística) ainda não foram vistas.
- O grafo parte do filtro e se expande por coautoria/orientação (até 3 níveis); quem ainda não foi coletado entra como nó “não coletado”, sem perfil.
- `ORIENTACOES-EM-ANDAMENTO`, bancas, eventos e projetos (`DADOS-COMPLEMENTARES`) ainda não são extraídos.
- O backup em nuvem faz tarball completo dos XMLs a cada rodada (não incremental).

## Créditos

Este projeto é baseado no **[scriptLattes](https://github.com/jpmenachalco/scriptLattes)**, criado por
Jesús P. Mena-Chalco e Roberto M. Cesar Jr., que abriu o caminho de extrair e organizar a produção
acadêmica da Plataforma Lattes. A ideia e o fluxo da prévia da busca vêm de lá. O Lattes Devour é uma
implementação própria em TypeScript, que guarda os dados num PostgreSQL e os serve num painel, em vez de
gerar um site estático. Se o seu objetivo é publicar relatórios de um grupo de pesquisa, vale conhecer o
projeto original.
