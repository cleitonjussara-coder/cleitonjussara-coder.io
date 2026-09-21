<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Services\FotoStorage;
use App\Services\PastaModelo;
use App\Services\RelatorioCv;
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
            ];
        }

        return response()->json(['ano' => $ano, 'colaboradores' => $out]);
    }

    public function notas(Request $r): JsonResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'user_id' => ['nullable', 'string', 'size:36'],
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
        ]);
        $alvo = $this->alvo($u, $d['user_id'] ?? null);
        $ano = (int) ($d['ano'] ?? now()->year);

        $q = Nota::query()->where('user_id', $alvo->id)->where('deleted', false)->where('ano', $ano);
        if (! empty($d['mes'])) {
            $q->where('mes', (int) $d['mes']);
        }
        $notas = $q->orderBy('data')->orderBy('created_at')->get();

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
                'pasta' => PastaModelo::pastaDaNota($alvo, $n),
            ];
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
        ]);
        $alvo = $this->alvo($u, $d['user_id'] ?? null);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = isset($d['mes']) ? (int) $d['mes'] : null;
        $comPlanilha = (bool) ($d['planilha'] ?? true);

        @ini_set('memory_limit', '512M');
        @set_time_limit(170);

        $q = Nota::query()->where('user_id', $alvo->id)->where('deleted', false)->where('ano', $ano);
        if ($mes) {
            $q->where('mes', $mes);
        }
        $notas = $q->orderBy('data')->get();
        abort_if($notas->isEmpty(), 404, 'Nenhuma nota nesse período');

        $tmp = tempnam(sys_get_temp_dir(), 'arq_').'.zip';
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
            $destino = PastaModelo::pastaDaNota($alvo, $n).'/'.PastaModelo::nomeArquivo($n, $ext);
            $base = $destino;
            for ($i = 2; isset($usados[$destino]); $i++) {   // duas notas iguais no mesmo dia → " (2)"
                $destino = preg_replace('/\.([a-z0-9]+)$/', " ($i).$1", $base);
            }
            $usados[$destino] = true;
            $zip->addFile($raiz.'/'.$n->foto_path, $destino);
            $zip->setCompressionName($destino, ZipArchive::CM_STORE);   // jpg não comprime; STORE é instantâneo
        }

        $pastaColab = PastaModelo::nomeColaborador($alvo).'/'.$ano;
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
                $cv = app(RelatorioCv::class);
                $xlsx = tempnam(sys_get_temp_dir(), 'cv_').'.xlsx';
                $ss = $cv->gerar($alvo, $ano);
                $cv->xlsx($ss, $xlsx);
                $ss->disconnectWorksheets();
                $zip->addFile($xlsx, "{$pastaColab}/Planilha_CV_{$ano}.xlsx");
            } catch (\Throwable $e) {
                $zip->addFromString("{$pastaColab}/PLANILHA NAO GERADA.txt", 'A Planilha CV não pôde ser gerada: '.$e->getMessage());
            }
        }

        $zip->close();   // só aqui os arquivos são lidos e gravados no .zip
        if ($xlsx && is_file($xlsx)) {
            @unlink($xlsx);
        }

        $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', PastaModelo::nomeColaborador($alvo));
        $periodo = $mes ? sprintf('%d-%02d', $ano, $mes) : (string) $ano;

        return response()->download($tmp, "Notas_{$nome}_{$periodo}.zip", ['Content-Type' => 'application/zip'])
            ->deleteFileAfterSend(true);
    }

    private function alvo(Colaborador $u, ?string $userId): Colaborador
    {
        $id = $userId ?: $u->id;
        abort_unless($id === $u->id || $u->veTudo(), 403, 'Sem permissão para os arquivos de outro colaborador');

        return Colaborador::findOrFail($id);
    }
}
