# Teste de carga (80 colaboradores)

Simula a equipe da próxima safra usando o app ao mesmo tempo. **Só roda na homologação** (`teste.pmservicosagronomicos.com.br`); o script e os comandos recusam produção.

## Passo a passo

1. Publicar a API nova na homologação (leva os comandos `carga:*`):
   `bash scripts/publicar.sh teste api`
2. No servidor (SSH renovado no painel), criar os usuários de teste:
   ```
   cd ~/api-teste && php84 artisan carga:preparar --n=80
   ```
3. Copiar os tokens para cá (arquivo ignorado pelo git, não suba):
   `scp ... :~/api-teste/storage/app/carga-tokens.json scripts/carga/carga-tokens.json`
   (mesmas opções de cifra do `publicar.sh`)
4. Rodar:
   `node scripts/carga/teste-carga.mjs`
   Opções: `--n 80 --notas 6 --janela 30 --planilhas 2 --simultaneas 25 --url <api de teste>`. **Use `--simultaneas 25`**: sem isso, 80 conexões do mesmo IP tomam 429 do nginx da Locaweb (limite por IP, ~50), e o teste mede o limite e não o servidor.
5. O relatório fica em `scripts/carga/resultado-<data>.md`.
6. **Limpar** (apaga usuários, notas e anexos de teste):
   ```
   cd ~/api-teste && php84 artisan carga:limpar
   rm scripts/carga/carga-tokens.json
   ```

## O que o teste mede

| Fase | O que simula |
|---|---|
| 1 abertura | 80 aparelhos abrindo o app: `/me`, `/notas`, `/repasses` |
| 2 fechamento | 80 × 6 notas com foto (~0,8 MB) espalhadas em 30 s: o pico do fim do dia |
| 3 planilhas | gestor gera 2 planilhas RDM/RDA ao mesmo tempo, com 20 aparelhos sincronizando |
| sonda | `GET /ping` a cada 0,5 s o tempo todo: o que um usuário sentiria |

## Limites do teste

- Os usuários de teste têm só ~6 notas; a planilha real (um colaborador com o ano inteiro) demora mais. Para estressar, aumente `--notas` ou gere a planilha de um colaborador real **na cópia** da homologação.
- Todos os aparelhos saem do mesmo IP/PC e da sua internet: a banda de upload sua pode limitar antes do servidor (80 × 6 × 0,8 MB ≈ 380 MB).
- Se aparecer 429, é limitador de requisições, não falta de capacidade.
