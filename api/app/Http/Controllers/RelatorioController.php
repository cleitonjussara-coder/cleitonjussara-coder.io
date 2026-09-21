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

    /** GET /relatorio/equipe?ano&mes — PDF da equipe no mês (gestor/admin). */
    public function equipe(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor ou admin gera o relatório da equipe');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = (int) ($d['mes'] ?? now()->month);

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);
        $arquivo = tempnam(sys_get_temp_dir(), 'eq_').'.pdf';
        app(\App\Services\RelatorioEquipePdf::class)->gerar($ano, $mes, $arquivo, $u);

        return response()->download($arquivo, sprintf('Relatorio_Equipe_%d-%02d.pdf', $ano, $mes), ['Content-Type' => 'application/pdf'])
            ->deleteFileAfterSend(true);
    }
}
