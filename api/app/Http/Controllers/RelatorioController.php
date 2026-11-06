<?php

namespace App\Http\Controllers;

use App\Models\Colaborador;
use App\Services\RelatorioCv;
use App\Services\RelatorioKm;
use App\Services\RelatorioRdmRda;
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
        /* 14/10/2026: a Planilha de C.V. é do regime CV. Para quem é RDM/RDA o modelo de CV ficava com as abas CV ALELO e
           CV REEMBOLSO repetindo as mesmas notas — entrega a planilha de RDM e RDA dele, que é a que existe para ele. */
        if (! $alvo->usaCartao()) {
            return $this->rdmrda($r);
        }

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);

        $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($alvo->nome ?: 'colaborador'));
        $arquivo = $this->temporario('cv_', $formato);
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
     * GET /relatorio/rdmrda?ano&user_id&formato=xlsx|pdf — Planilha de RDM e RDA
     * no modelo da empresa (21/09/2026), para quem está no regime RDM/RDA.
     * xlsx = o próprio modelo preenchido; pdf = montado dos dados (RelatorioRdmRdaPdf).
     */
    public function rdmrda(Request $r): BinaryFileResponse
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

        @ini_set('memory_limit', '768M');
        @set_time_limit(180);
        $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($alvo->nome ?: 'colaborador'));
        $arquivo = $this->temporario('rdm_', $formato);
        if ($formato === 'pdf') {
            app(\App\Services\RelatorioRdmRdaPdf::class)->gerar($alvo, $ano, $arquivo);
        } else {
            $svc = app(RelatorioRdmRda::class);
            $ss = $svc->gerar($alvo, $ano);
            $svc->xlsx($ss, $arquivo);
            $ss->disconnectWorksheets();
        }

        return response()->download($arquivo, "Planilha_RDM_RDA_{$nome}_{$ano}.{$formato}", [
            'Content-Type' => $formato === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend(true);
    }

    /**
     * GET /relatorio/cv-equipe?ano&ids=a,b,c&modo=unico|zip — Planilha de C.V.
     * (modelo da empresa) de vários colaboradores (21/09/2026). Gestor/admin.
     *   modo=unico (padrão): UM xlsx com as 4 abas de cada um (Ana_RDM_RDA…).
     *   modo=zip: um xlsx completo por colaborador, num ZIP.
     * `ids` = quem o gestor marcou na tela; sem `ids`, todo colaborador ativo
     * que tem nota ou repasse no ano (planilha vazia não ajuda e custa segundos)
     * ou que carrega saldo de ano anterior (04/11/2026: sem ele o RESUMO sai menor que a dívida real).
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

        /* 06/11/2026: a geração saiu para PlanilhasEquipe. O app usa a fila (RelatorioPedidoController) para muita gente;
           esta rota segue para poucas pessoas e para aparelho antigo. */
        $planilhas = app(\App\Services\PlanilhasEquipe::class);
        $ids = array_values(array_filter(array_map('trim', explode(',', (string) ($d['ids'] ?? '')))));
        $colabs = $planilhas->colaboradores($ano, $ids);
        abort_if($colabs->isEmpty(), 404, $ids ? 'Nenhum dos colaboradores marcados foi encontrado' : "Nenhum colaborador ativo com lançamento em {$ano}");

        @ini_set('memory_limit', '1024M');
        @set_time_limit(900);   // modelo RDM/RDA leva ~20 s por pessoa

        $arquivo = $this->temporario('cveq_', $modo === 'zip' ? 'zip' : 'xlsx');
        $planilhas->gerar($colabs, $ano, $modo, $arquivo);

        return response()->download($arquivo, $planilhas->nome($modo, $ano), [
            'Content-Type' => $modo === 'zip' ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ])->deleteFileAfterSend(true);
    }

    /**
     * GET /relatorio/km?ano&mes&ids=a,b&modo=unico|zip — Planilha de KM (31/10/2026), montada no servidor.
     * Colaborador comum só gera a própria; gestor/admin escolhem quem (sem `ids` = quem tem leitura no ano).
     *   modo=unico: um xlsx (RESUMO + DIA A DIA + uma aba por pessoa) · modo=zip: um xlsx por pessoa.
     */
    public function km(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_if($u->soLeitura(), 403, 'Contabilidade não usa este módulo.');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
            'ids' => ['nullable', 'string', 'max:4000'],
            'modo' => ['nullable', 'in:unico,zip'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = (int) ($d['mes'] ?? now()->month);
        $modo = $d['modo'] ?? 'unico';
        $anual = app(FrotaController::class)->anual($r)->getData(true);   // já respeita quem vê o quê

        if ($r->query('tipo') === 'controle') {   // planilha de controle da frota: veículo × mês, motorista × mês e leituras
            $svc = app(RelatorioKm::class);
            $arquivo = $this->temporario('kmc_', 'xlsx');
            $ss = $svc->gerarControle($anual);
            $svc->xlsx($ss, $arquivo);
            $ss->disconnectWorksheets();

            return response()->download($arquivo, "Planilha_Controle_Frota_{$ano}.xlsx", ['Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])->deleteFileAfterSend(true);
        }

        $ids = array_values(array_filter(array_map('trim', explode(',', (string) ($d['ids'] ?? '')))));
        $pessoas = [];
        foreach ($anual['motoristas'] as $m) {
            if (($u->veTudo() || $m['user_id'] === $u->id) && (! $ids || in_array($m['user_id'], $ids, true))) {
                $pessoas[] = ['user_id' => $m['user_id'], 'nome' => $m['nome']];
            }
        }
        usort($pessoas, fn ($a, $b) => strcasecmp($a['nome'], $b['nome']));
        abort_unless($pessoas, 404, 'Ninguém com leitura de km neste ano');

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);
        $svc = app(RelatorioKm::class);
        $slug = fn ($s) => preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($s ?: 'colaborador'));
        if ($modo === 'unico') {
            $arquivo = $this->temporario('km_', 'xlsx');
            $ss = $svc->gerar($anual, $pessoas, $mes);
            $svc->xlsx($ss, $arquivo);
            $ss->disconnectWorksheets();
            $nome = count($pessoas) === 1 ? 'Planilha_KM_'.$slug($pessoas[0]['nome'])."_{$ano}.xlsx" : "Planilha_KM_Selecionados_{$ano}.xlsx";

            return response()->download($arquivo, $nome, ['Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])->deleteFileAfterSend(true);
        }
        $zipPath = $this->temporario('kmz_', 'zip');
        $zip = new \ZipArchive();
        abort_unless($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) === true, 500, 'Não consegui criar o ZIP');
        $temps = [];
        try {
            foreach ($pessoas as $p) {
                $tmp = $this->temporario('km_', 'xlsx');
                $temps[] = $tmp;
                $ss = $svc->gerar($anual, [$p], $mes);
                $svc->xlsx($ss, $tmp);
                $ss->disconnectWorksheets();
                $zip->addFile($tmp, 'Planilha_KM_'.$slug($p['nome'])."_{$ano}.xlsx");
            }
            $zip->close();
        } finally {
            foreach ($temps as $t) {
                @unlink($t);
            }
        }

        return response()->download($zipPath, "Planilhas_KM_{$ano}.zip", ['Content-Type' => 'application/zip'])->deleteFileAfterSend(true);
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
        $arquivo = $this->temporario('eq_', 'pdf');
        app(\App\Services\RelatorioEquipePdf::class)->gerar($ano, $mes, $arquivo, $u, $ids);

        return response()->download($arquivo, sprintf('Relatorio_Equipe_%d-%02d.pdf', $ano, $mes), ['Content-Type' => 'application/pdf'])
            ->deleteFileAfterSend(true);
    }

    /**
     * GET /relatorio/faturamento?ano&mes — PDF do que a empresa pagou direto no mês (26/09/2026).
     * formato=xlsx (22/10/2026): a Planilha de Faturamento do ANO inteiro (RESUMO + uma aba por mês); `mes` não conta.
     */
    public function faturamento(Request $r): BinaryFileResponse
    {
        $u = $r->user();
        abort_unless($u->veTudo(), 403, 'Só gestor, admin ou contabilidade gera o relatório de Faturamento');
        $d = $r->validate([
            'ano' => ['nullable', 'integer', 'min:2020', 'max:2100'],
            'mes' => ['nullable', 'integer', 'min:1', 'max:12'],
            'formato' => ['nullable', 'in:pdf,xlsx'],
        ]);
        $ano = (int) ($d['ano'] ?? now()->year);
        $mes = (int) ($d['mes'] ?? now()->month);

        @ini_set('memory_limit', '512M');
        @set_time_limit(120);
        if (($d['formato'] ?? 'pdf') === 'xlsx') {
            $arquivo = $this->temporario('fat_', 'xlsx');
            $svc = app(\App\Services\RelatorioFaturamentoXlsx::class);
            /* com mes: relatório só daquele mês, do botão da pasta Faturamento; sem mes: a planilha do ano inteiro */
            $doMes = ! empty($d['mes']) ? (int) $d['mes'] : null;
            $ss = $svc->gerar($ano, $u, $doMes);
            $svc->xlsx($ss, $arquivo);
            $ss->disconnectWorksheets();

            return response()->download($arquivo, $doMes ? sprintf('Relatorio_Faturamento_%d-%02d.xlsx', $ano, $doMes) : "Planilha_Faturamento_{$ano}.xlsx", ['Content-Type' => 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'])
                ->deleteFileAfterSend(true);
        }
        $arquivo = $this->temporario('fat_', 'pdf');
        app(\App\Services\RelatorioFaturamentoPdf::class)->gerar($ano, $mes, $arquivo, $u);

        return response()->download($arquivo, sprintf('Relatorio_Faturamento_%d-%02d.pdf', $ano, $mes), ['Content-Type' => 'application/pdf'])
            ->deleteFileAfterSend(true);
    }
}
