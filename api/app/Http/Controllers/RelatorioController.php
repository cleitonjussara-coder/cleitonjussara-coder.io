<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Services\RelatorioCv;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\BinaryFileResponse;

/**
 * GET /relatorio/cv?ano=2026&user_id=…&formato=xlsx|pdf
 * Planilha de C.V. no modelo da empresa, preenchida pelo servidor.
 *   colaborador → só a própria; gestor/admin → qualquer um.
 * Independe do Drive: o arquivo é gerado na hora e baixado direto.
 */
class RelatorioController extends Controller
{
    public function __construct(private RelatorioCv $cv) {}

    public function cv(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'user_id' => ['nullable', 'string', 'size:36'],
            'formato' => ['nullable', 'in:xlsx,pdf'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $alvoId = $d['user_id'] ?? $u->id;
        abort_unless($alvoId === $u->id || $u->veTudo(), 403, 'Sem permissão para o relatório de outro colaborador');
        $alvo = Colaborador::findOrFail($alvoId);
        $formato = $d['formato'] ?? 'xlsx';

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);

        $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($alvo->nome ?: 'colaborador'));
        $arquivo = tempnam(sys_get_temp_dir(), 'cv_').'.'.$formato;
        if ($formato === 'pdf') {
            app(\App\Services\RelatorioCvPdf::class)->gerar($alvo, $ano, $arquivo);   // HTML enxuto: cabe na página
        } else {
            $ss = $this->cv->gerar($alvo, $ano);
            $this->cv->xlsx($ss, $arquivo);
            $ss->disconnectWorksheets();
        }

        return response()->download($arquivo, "Planilha_CV_{$nome}_{$ano}.{$formato}", [
            'Content-Type' => $formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend(true);
    }

    /**
     * GET /relatorio/cv-equipe?ano&ids=a,b,c&modo=unico|zip — Planilha de C.V.
     * (modelo da empresa) de vários colaboradores (21/09/2026). Gestor/admin.
     *   modo=unico (padrão): UM xlsx com as 4 abas de cada um (Ana_RDM_RDA…).
     *   modo=zip: um xlsx completo por colaborador, num ZIP.
     * `ids` = quem o gestor marcou na tela; sem `ids`, todo colaborador ativo
     * que tem nota ou repasse no ano (planilha vazia não ajuda e custa segundos).
     */
    public function cvEquipe(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor ou admin gera as planilhas da equipe');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'ids' => ['nullable', 'string', 'max:4000'],
            'modo' => ['nullable', 'in:unico,zip'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $modo = $d['modo'] ?? 'unico';

        $q = Colaborador::query()->orderBy('nome');
        $ids = array_values(array_filter(array_map('trim', explode(',', (string) ($d['ids'] ?? '')))));
        if ($ids) {
            $q->whereIn('id', array_slice($ids, 0, 200));
        } else {
            $comNota = \App\Models\Nota::query()->where('deleted', false)->where('ano', $ano)->distinct()->pluck('user_id');
            $comRep = \App\Models\Repasse::query()->where('deleted', false)->where('ano', $ano)->distinct()->pluck('user_id');
            $q->where('ativo', true)->where('regime', 'cv')->whereIn('id', $comNota->merge($comRep)->unique());   // só quem é CV tem Planilha CV (21/09/2026)
        }
        $colabs = $q->get();
        abort_if($colabs->isEmpty(), 404, $ids ? 'Nenhum dos colaboradores marcados foi encontrado' : "Nenhum colaborador ativo com lançamento em {$ano}");

        @ini_set('memory_limit', '1024M');
        @set_time_limit(600);

        if ($modo === 'unico') {
            $arquivo = tempnam(sys_get_temp_dir(), 'cveq_').'.xlsx';
            $ss = $this->cv->gerarUnico($colabs, $ano);
            $this->cv->xlsxSemCalculo($ss, $arquivo);
            $ss->disconnectWorksheets();

            return response()->download($arquivo, "Planilha_CV_Equipe_{$ano}.xlsx", [
                'Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            ])->deleteFileAfterSend(true);
        }

        $zipPath = tempnam(sys_get_temp_dir(), 'cveq_').'.zip';
        $zip = new \ZipArchive();
        abort_unless($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true, 500, 'Não consegui criar o ZIP');
        $temps = [];
        try {
            /* o mesmo RESUMO do Excel único, como arquivo próprio no ZIP */
            $tmp = tempnam(sys_get_temp_dir(), 'cv_').'.xlsx';
            $temps[] = $tmp;
            $ss = new \PhpOffice\PhpSpreadsheet\Spreadsheet();
            $ss->removeSheetByIndex(0);
            $this->cv->abaResumo($ss, $colabs, $ano);
            $this->cv->xlsxSemCalculo($ss, $tmp);
            $ss->disconnectWorksheets();
            $zip->addFile($tmp, "Resumo_Geral_{$ano}.xlsx");

            foreach ($colabs as $c) {
                $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($c->nome ?: 'colaborador'));
                $tmp = tempnam(sys_get_temp_dir(), 'cv_').'.xlsx';
                $temps[] = $tmp;
                $ss = $this->cv->gerar($c, $ano);
                $this->cv->xlsx($ss, $tmp);
                $ss->disconnectWorksheets();
                unset($ss);
                $zip->addFile($tmp, "Planilha_CV_{$nome}_{$ano}.xlsx");
            }
            $zip->close();   // é aqui que os arquivos são lidos e gravados no zip
        } finally {
            foreach ($temps as $t) { @unlink($t); }
        }

        return response()->download($zipPath, "Planilhas_CV_Equipe_{$ano}.zip", ['Content-Type' => 'application/zip'])
            ->deleteFileAfterSend(true);
    }

    /** GET /relatorio/equipe?ano&mes — PDF da equipe no mês (gestor/admin). */
    public function equipe(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor ou admin gera o relatório da equipe');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
            'ids' => ['nullable', 'string', 'max:4000'],   // colaboradores marcados na tela (21/09/2026)
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = (int) ($d['mes'] ?? now()->month);
        $ids = array_values(array_filter(array_map('trim', explode(',', (string) ($d['ids'] ?? ''))))) ?: null;

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);
        $arquivo = tempnam(sys_get_temp_dir(), 'eq_').'.pdf';
        app(\App\Services\RelatorioEquipePdf::class)->gerar($ano, $mes, $arquivo, $u, $ids);

        return response()->download($arquivo, sprintf('Relatorio_Equipe_%d-%02d.pdf', $ano, $mes), ['Content-Type' => 'application/pdf'])
            ->deleteFileAfterSend(true);
    }
}
