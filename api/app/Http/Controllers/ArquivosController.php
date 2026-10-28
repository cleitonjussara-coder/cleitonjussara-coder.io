<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use App\Services\FotoStorage;
use App\Services\PastaModelo;
use App\Services\RelatorioCv;
use App\Services\RelatorioFaturamentoXlsx;
use App\Services\RelatorioRdmRda;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;
use ZipArchive;

/**
 * Tela "Arquivos" (19/09/2026): o que o gestor ia buscar no Drive, agora
 * direto do servidor, montado a partir do banco (nada de varrer disco).
 *   GET /arquivos/resumo?ano            → por colaborador e mês: qtd e total
 *   GET /arquivos/notas?user_id&ano&mes → notas do mês com miniatura assinada
 *   GET /arquivos/zip?user_id&ano[&mes] → ZIP na árvore da pasta modelo
 * Colaborador vê só o próprio; gestor/admin vê qualquer um.
 */
class ArquivosController extends Controller
{
    public function __construct(private FotoStorage $fotos, private FotoController $urls) {}

    public function resumo(Request $r): JsonResponse
    {
        $u = $r->user();
        $ano = (int) ($r->validate(['ano' => ['nullable', 'integer', 'min:2020', 'max:2100']])['ano'] ?? now()->year);

        $linhas = Nota::query()->visiveisPara($u)
            ->where('deleted', false)->where('ano', $ano)
            ->selectRaw("user_id, mes, count(*) as qtd, sum(valor) as total, sum(case when foto_path is not null and foto_path != '' then 1 else 0 end) as com_anexo")
            ->groupBy('user_id', 'mes')->get();

        $colabs = Colaborador::query()->orderBy('nome')->get();
        $saldos = $u->veTudo() ? $this->saldosEquipe($ano, $colabs) : [];
        $out = [];
        foreach ($colabs as $c) {
            if (! $u->veTudo() && $c->id !== $u->id) {
                continue;
            }
            $meses = [];
            $qtd = 0;
            $total = 0.0;
            $comAnexo = 0;
            foreach ($linhas->where('user_id', $c->id) as $l) {
                $meses[] = ['mes' => (int) $l->mes, 'qtd' => (int) $l->qtd, 'total' => round((float) $l->total, 2), 'com_anexo' => (int) $l->com_anexo];
                $qtd += (int) $l->qtd;
                $total += (float) $l->total;
                $comAnexo += (int) $l->com_anexo;
            }
            usort($meses, fn ($a, $b) => $a['mes'] <=> $b['mes']);
            $out[] = [
                'user_id' => $c->id, 'nome' => $c->nome, 'email' => $c->email, 'role' => $c->role, 'ativo' => (bool) $c->ativo,
                'foto_path' => $c->foto_path, 'pasta' => PastaModelo::nomeColaborador($c),
                'qtd' => $qtd, 'total' => round($total, 2), 'com_anexo' => $comAnexo, 'meses' => $meses,
                'saldo' => $saldos[$c->id] ?? null,
            ];
        }

        /* Pasta "Faturamento": tudo que a empresa pagou direto (pagamento='empresa'), de qualquer dono ou sem dono.
           Só quem vê tudo; é uma visão a mais — a nota continua também na pasta do colaborador. */
        $fat = null;
        if ($u->veTudo()) {
            $meses = [];
            foreach (Nota::query()->where('pagamento', 'empresa')->where('deleted', false)->where('ano', $ano)
                ->selectRaw("mes, count(*) as qtd, sum(valor) as total, sum(case when foto_path is not null and foto_path != '' then 1 else 0 end) as com_anexo")
                ->groupBy('mes')->orderBy('mes')->get() as $l) {
                $meses[] = ['mes' => (int) $l->mes, 'qtd' => (int) $l->qtd, 'total' => round((float) $l->total, 2), 'com_anexo' => (int) $l->com_anexo];
            }
            $fat = [
                'qtd' => array_sum(array_column($meses, 'qtd')), 'total' => round(array_sum(array_column($meses, 'total')), 2),
                'com_anexo' => array_sum(array_column($meses, 'com_anexo')), 'meses' => $meses,
            ];
        }

        return response()->json(['ano' => $ano, 'colaboradores' => $out, 'faturamento' => $fat]);
    }

    /**
     * Quanto a empresa deve a cada colaborador, acumulado até dezembro de $ano (28/10/2026, cartão da lista de
     * Arquivos). Mesma conta do app (_devedorDe, _gastoBolsoPorTipo, _cartaoPorTipo) e do PDF da equipe:
     *   RDM/RDA → gasto (sem Faturamento) − recebido confirmado, por tipo; a recarga do cartão fica fora;
     *   C.V.    → notas do bolso (pagamento=carteira) − repasse recebido; RDM/RDA mostram só a composição do bolso;
     *   cartão  → recargas − gasto no cartão, no ANO (igual à planilha CV; negativo = empresa deve).
     *
     * @return array<string, array<string, mixed>>
     */
    private function saldosEquipe(int $ano, $colabs): array
    {
        $k = $ano * 12 + 12;
        $gastos = Nota::query()->where('deleted', false)->whereNotNull('user_id')
            ->whereRaw('(ano * 12 + mes) <= ?', [$k])
            ->selectRaw('user_id, tipo, pagamento, ano, SUM(valor) AS v')->groupBy('user_id', 'tipo', 'pagamento', 'ano')->get();
        $repasses = Repasse::query()->where('deleted', false)
            ->whereRaw('(ano * 12 + mes) <= ?', [$k])
            ->where(fn ($q) => $q->whereNull('kind')->orWhere('kind', 'received'))
            ->whereNotNull('confirmado_em')
            ->selectRaw('user_id, tipo, destino, ano, SUM(valor) AS v')->groupBy('user_id', 'tipo', 'destino', 'ano')->get();

        $a = [];
        foreach ($gastos as $g) {
            $x = &$a[$g->user_id];
            $x ??= ['gasto' => ['RDM' => 0.0, 'RDA' => 0.0], 'bolso' => ['RDM' => 0.0, 'RDA' => 0.0], 'cartaoAno' => 0.0, 'recebido' => ['RDM' => 0.0, 'RDA' => 0.0], 'repassado' => 0.0, 'recargaAno' => 0.0];
            $v = (float) $g->v;
            $t = $g->tipo;
            if ($g->pagamento !== 'empresa') {
                if (isset($x['gasto'][$t])) {
                    $x['gasto'][$t] += $v;
                }
                if ($g->pagamento === 'carteira' && isset($x['bolso'][$t])) {
                    $x['bolso'][$t] += $v;
                }
                if ($g->pagamento !== 'carteira' && (int) $g->ano === $ano) {
                    $x['cartaoAno'] += $v;
                }
            }
            unset($x);
        }
        foreach ($repasses as $r) {
            $x = &$a[$r->user_id];
            $x ??= ['gasto' => ['RDM' => 0.0, 'RDA' => 0.0], 'bolso' => ['RDM' => 0.0, 'RDA' => 0.0], 'cartaoAno' => 0.0, 'recebido' => ['RDM' => 0.0, 'RDA' => 0.0], 'repassado' => 0.0, 'recargaAno' => 0.0];
            $v = (float) $r->v;
            if ($r->destino === 'recarga') {
                if ((int) $r->ano === $ano) {
                    $x['recargaAno'] += $v;
                }
            } else {
                $x['repassado'] += $v;
                if (isset($x['recebido'][$r->tipo])) {
                    $x['recebido'][$r->tipo] += $v;
                }
            }
            unset($x);
        }

        $out = [];
        foreach ($colabs as $c) {
            $x = $a[$c->id] ?? ['gasto' => ['RDM' => 0.0, 'RDA' => 0.0], 'bolso' => ['RDM' => 0.0, 'RDA' => 0.0], 'cartaoAno' => 0.0, 'recebido' => ['RDM' => 0.0, 'RDA' => 0.0], 'repassado' => 0.0, 'recargaAno' => 0.0];
            if ($c->usaCartao()) {
                $bolso = $x['bolso']['RDM'] + $x['bolso']['RDA'];
                $out[$c->id] = [
                    'cv' => true,
                    'deve' => round($bolso - $x['repassado'], 2),
                    'rdm' => round($x['bolso']['RDM'], 2), 'rda' => round($x['bolso']['RDA'], 2),
                    'cartao_gasto' => round($x['cartaoAno'], 2), 'cartao_saldo' => round($x['recargaAno'] - $x['cartaoAno'], 2),
                    'carteira' => round($bolso, 2),
                ];
            } else {
                $rdm = $x['gasto']['RDM'] - $x['recebido']['RDM'];
                $rda = $x['gasto']['RDA'] - $x['recebido']['RDA'];
                $out[$c->id] = [
                    'cv' => false,
                    /* RDM e RDA são independentes (como no PDF da equipe): crédito de um não paga a dívida do outro */
                    'deve' => round(max(0, $rdm) + max(0, $rda), 2),
                    'rdm' => round($rdm, 2), 'rda' => round($rda, 2),
                    'cartao_gasto' => null, 'cartao_saldo' => null,
                    'carteira' => round($x['gasto']['RDM'] + $x['gasto']['RDA'], 2),
                ];
            }
        }

        return $out;
    }

    /** Notas de Faturamento do período (todas as pessoas), mais antigas primeiro. */
    private function notasFaturamento(int $ano, ?int $mes)
    {
        $q = Nota::query()->where('pagamento', 'empresa')->where('deleted', false)->where('ano', $ano);
        if ($mes) {
            $q->where('mes', $mes);
        }

        return $q->orderBy('data')->orderBy('created_at')->get();
    }

    public function notas(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'user_id' => ['nullable', 'string', 'size:36'],
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
            'faturamento' => ['nullable', 'boolean'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);

        $fat = (bool) ($d['faturamento'] ?? false);
        if ($fat) {
            abort_unless($u->veTudo(), 403, 'Só gestor, admin ou contabilidade abrem o Faturamento');
            $alvo = $u;
            $notas = $this->notasFaturamento($ano, ! empty($d['mes']) ? (int) $d['mes'] : null);
        } else {
            $alvo = $this->alvo($u, $d['user_id'] ?? null);
            $q = Nota::query()->where('user_id', $alvo->id)->where('deleted', false)->where('ano', $ano);
            if (! empty($d['mes'])) {
                $q->where('mes', (int) $d['mes']);
            }
            $notas = $q->orderBy('data')->orderBy('created_at')->get();
        }

        $out = [];
        foreach ($notas as $n) {
            $temArq = $this->fotos->existe($n->foto_path);
            $ext = $temArq ? strtolower(pathinfo($n->foto_path, PATHINFO_EXTENSION)) : null;
            $out[] = [
                'id' => $n->id, 'data' => $n->data?->format('Y-m-d'), 'mes' => $n->mes, 'ano' => $n->ano,
                'tipo' => $n->tipo, 'subtipo' => $n->subtipo, 'grupo' => PastaModelo::grupoCurto($n),
                'razao_social' => $n->razao_social, 'cnpj' => $n->cnpj, 'valor' => (float) $n->valor,
                'documento' => $n->documento, 'numero' => $n->numero, 'observacao' => $n->observacao,
                'foto_path' => $temArq ? $n->foto_path : null, 'ext' => $ext,
                'mini_url' => $temArq && in_array($ext, ['jpg', 'jpeg', 'png', 'gif', 'webp'], true) ? $this->urls->urlMini($n->foto_path) : null,
                'arquivo' => $temArq ? PastaModelo::nomeArquivo($n, $ext) : null,
                'pasta' => $fat ? PastaModelo::pastaSob('Faturamento', $n) : PastaModelo::pastaDaNota($alvo, $n),
            ];
        }

        if ($fat) {
            return response()->json(['faturamento' => true, 'nome' => 'Faturamento', 'ano' => $ano, 'mes' => $d['mes'] ?? null, 'notas' => $out]);
        }

        return response()->json(['user_id' => $alvo->id, 'nome' => $alvo->nome, 'ano' => $ano, 'mes' => $d['mes'] ?? null, 'notas' => $out]);
    }

    /**
     * ZIP do mês (ou do ano) na árvore da pasta modelo, com a Planilha CV do
     * ano dentro. ZipArchive grava em arquivo temporário: não segura tudo na
     * memória, então o tamanho do mês não importa. Baixa e apaga.
     */
    public function zip(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'user_id' => ['nullable', 'string', 'size:36'],
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
            'planilha' => ['nullable', 'boolean'],
            'faturamento' => ['nullable', 'boolean'],
        ]);
        $fat = (bool) ($d['faturamento'] ?? false);
        abort_if($fat && ! $u->veTudo(), 403, 'Só gestor, admin ou contabilidade baixam o Faturamento');
        $alvo = $fat ? $u : $this->alvo($u, $d['user_id'] ?? null);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = isset($d['mes']) ? (int) $d['mes'] : null;
        $comPlanilha = (bool) ($d['planilha'] ?? true);

        @ini_set('memory_limit', '512M');
        @set_time_limit(170);

        if ($fat) {
            $notas = $this->notasFaturamento($ano, $mes);
        } else {
            $q = Nota::query()->where('user_id', $alvo->id)->where('deleted', false)->where('ano', $ano);
            if ($mes) {
                $q->where('mes', $mes);
            }
            $notas = $q->orderBy('data')->get();
        }
        abort_if($notas->isEmpty(), 404, 'Nenhuma nota nesse período');

        $tmp = $this->temporario('arq_', 'zip');
        $zip = new ZipArchive;
        abort_unless($zip->open($tmp, ZipArchive::CREATE | ZipArchive::OVERWRITE) === true, 500, 'Não consegui criar o ZIP');

        $raiz = rtrim($this->fotos->disk()->path(''), '/\\');
        $usados = [];
        $semAnexo = [];
        foreach ($notas as $n) {
            if (! $this->fotos->existe($n->foto_path)) {
                $semAnexo[] = $n;

                continue;
            }
            $ext = strtolower(pathinfo($n->foto_path, PATHINFO_EXTENSION));
            $destino = $this->nomeLivre(($fat ? PastaModelo::pastaSob('Faturamento', $n) : PastaModelo::pastaDaNota($alvo, $n)).'/'.PastaModelo::nomeArquivo($n, $ext), $usados);
            $zip->addFile($raiz.'/'.$n->foto_path, $destino);
            $zip->setCompressionName($destino, ZipArchive::CM_STORE);   // jpg não comprime; STORE é instantâneo
        }

        $pastaColab = ($fat ? 'Faturamento' : PastaModelo::nomeColaborador($alvo)).'/'.$ano;
        if ($semAnexo) {
            $txt = 'Notas sem anexo no servidor ('.count($semAnexo)."):\n";
            foreach ($semAnexo as $n) {
                $txt .= sprintf("%s  %-40s  R$ %s  [%s]\n", $n->data?->format('Y-m-d') ?: 'sem-data', mb_substr((string) $n->razao_social, 0, 40), number_format((float) $n->valor, 2, ',', '.'), PastaModelo::grupoCurto($n));
            }
            $zip->addFromString("{$pastaColab}/SEM ANEXO.txt", $txt);
        }

        $xlsx = null;
        if ($comPlanilha) {
            try {
                /* 14/10/2026: cada um recebe a planilha do SEU regime. Antes era sempre a de CV: para quem é RDM/RDA as
                   abas CV ALELO e CV REEMBOLSO ficavam com as mesmas notas ("tudo junto") e a planilha dele ficava
                   igual à de quem é CV. */
                /* 22/10/2026: a pasta Faturamento leva a Planilha de Faturamento do ano (RelatorioFaturamentoXlsx). */
                $xlsx = $this->temporario('cv_', 'xlsx');
                if ($fat) {
                    $svc = app(RelatorioFaturamentoXlsx::class);
                    $rotulo = 'Faturamento';
                    $ss = $svc->gerar($ano, $u);
                } else {
                    $ehCv = $alvo->usaCartao();
                    $svc = $ehCv ? app(RelatorioCv::class) : app(RelatorioRdmRda::class);
                    $rotulo = $ehCv ? 'CV' : 'RDM_RDA';
                    $ss = $svc->gerar($alvo, $ano);
                }
                $svc->xlsx($ss, $xlsx);
                $ss->disconnectWorksheets();
                $zip->addFile($xlsx, "{$pastaColab}/Planilha_{$rotulo}_{$ano}.xlsx");
            } catch (\Throwable $e) {
                $zip->addFromString("{$pastaColab}/PLANILHA NAO GERADA.txt", 'A planilha não pôde ser gerada: '.$e->getMessage());
            }
        }

        $zip->close();   // só aqui os arquivos são lidos e gravados no .zip
        if ($xlsx && is_file($xlsx)) {
            @unlink($xlsx);
        }

        $nome = $fat ? 'Faturamento' : preg_replace('/[^A-Za-z0-9_-]+/', '_', PastaModelo::nomeColaborador($alvo));
        $periodo = $mes ? sprintf('%d-%02d', $ano, $mes) : (string) $ano;

        return response()->download($tmp, "Notas_{$nome}_{$periodo}.zip", ['Content-Type' => 'application/zip'])
            ->deleteFileAfterSend(true);
    }

    /**
     * ZIP da EQUIPE inteira (03/10/2026, pedido da contabilidade): as notas de
     * todos os colaboradores de uma vez, cada um na sua pasta, na mesma árvore
     * do ZIP individual. Sem planilhas aqui — elas têm rota própria
     * (/relatorio/cv-equipe?modo=zip) e levam ~20 s por pessoa no modelo
     * RDM/RDA; juntar as duas coisas estouraria o tempo de uma requisição.
     * Só gestor, admin e contabilidade.
     */
    public function zipEquipe(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor, admin ou contabilidade baixam as notas da equipe');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = isset($d['mes']) ? (int) $d['mes'] : null;

        @ini_set('memory_limit', '512M');
        @set_time_limit(600);

        $q = Nota::query()->where('deleted', false)->where('ano', $ano)->whereNotNull('user_id');
        if ($mes) {
            $q->where('mes', $mes);
        }
        $porColab = $q->orderBy('data')->get()->groupBy('user_id');
        abort_if($porColab->isEmpty(), 404, 'Nenhuma nota nesse período');

        $tmp = $this->temporario('arq_', 'zip');
        $zip = new ZipArchive;
        abort_unless($zip->open($tmp, ZipArchive::CREATE | ZipArchive::OVERWRITE) === true, 500, 'Não consegui criar o ZIP');

        $raiz = rtrim($this->fotos->disk()->path(''), '/\\');
        $usados = [];
        $resumo = '';
        foreach (Colaborador::query()->whereIn('id', $porColab->keys())->orderBy('nome')->get() as $c) {
            $semAnexo = [];
            $qtd = 0;
            $total = 0.0;
            foreach ($porColab[$c->id] as $n) {
                $qtd++;
                $total += (float) $n->valor;
                if (! $this->fotos->existe($n->foto_path)) {
                    $semAnexo[] = $n;

                    continue;
                }
                $ext = strtolower(pathinfo($n->foto_path, PATHINFO_EXTENSION));
                $destino = $this->nomeLivre(PastaModelo::pastaDaNota($c, $n).'/'.PastaModelo::nomeArquivo($n, $ext), $usados);
                $zip->addFile($raiz.'/'.$n->foto_path, $destino);
                $zip->setCompressionName($destino, ZipArchive::CM_STORE);
            }
            $pasta = PastaModelo::nomeColaborador($c).'/'.$ano;
            if ($semAnexo) {
                $txt = 'Notas sem anexo no servidor ('.count($semAnexo)."):\n";
                foreach ($semAnexo as $n) {
                    $txt .= sprintf("%s  %-40s  R$ %s  [%s]\n", $n->data?->format('Y-m-d') ?: 'sem-data', mb_substr((string) $n->razao_social, 0, 40), number_format((float) $n->valor, 2, ',', '.'), PastaModelo::grupoCurto($n));
                }
                $zip->addFromString("{$pasta}/SEM ANEXO.txt", $txt);
            }
            $resumo .= sprintf("%-40s %4d nota(s)  R$ %s  (%d sem anexo)\n", PastaModelo::nomeColaborador($c), $qtd, number_format($total, 2, ',', '.'), count($semAnexo));
        }
        $zip->addFromString('LEIAME.txt', 'Notas da equipe — '.($mes ? sprintf('%02d/%d', $mes, $ano) : (string) $ano)."\n\n".$resumo."\nUma pasta por colaborador (Ano / Grupo / Categoria / mês). As planilhas baixam à parte, no botão \"Planilhas de todos\".\n");
        $zip->close();

        $periodo = $mes ? sprintf('%d-%02d', $ano, $mes) : (string) $ano;

        return response()->download($tmp, "Notas_Equipe_{$periodo}.zip", ['Content-Type' => 'application/zip'])
            ->deleteFileAfterSend(true);
    }

    /**
     * Caminho ainda não usado no ZIP: duas notas iguais no mesmo dia → " (2)". A comparação ignora maiúsculas
     * (22/10/2026): "HOTEL IPE" e "Hotel Ipe" são o mesmo arquivo no Windows, e ao extrair um sobrescrevia o outro —
     * na pasta Faturamento isso é comum (pessoas diferentes, mesmo hotel, mesmo dia).
     */
    private function nomeLivre(string $destino, array &$usados): string
    {
        $base = $destino;
        for ($i = 2; isset($usados[mb_strtolower($destino)]); $i++) {
            $destino = preg_replace('/\.([a-z0-9]+)$/', " ($i).$1", $base);
        }
        $usados[mb_strtolower($destino)] = true;

        return $destino;
    }

    private function alvo(Colaborador $u, ?string $userId): Colaborador
    {
        $id = $userId ?: $u->id;
        abort_unless($id === $u->id || $u->veTudo(), 403, 'Sem permissão para os arquivos de outro colaborador');

        return Colaborador::findOrFail($id);
    }
}
