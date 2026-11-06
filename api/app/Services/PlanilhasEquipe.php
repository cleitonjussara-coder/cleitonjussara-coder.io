<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use App\Models\Repasse;
use Illuminate\Support\Collection;
use PhpOffice\PhpSpreadsheet\Spreadsheet;
use RuntimeException;
use ZipArchive;

/**
 * Planilhas de vários colaboradores (06/11/2026). Saiu do RelatorioController para valer igual na requisição direta e na fila.
 *   modo unico: UM xlsx com as abas de cada um.
 *   modo zip: um xlsx completo por colaborador, mais o RESUMO, num ZIP.
 */
class PlanilhasEquipe
{
    public function __construct(private RelatorioCv $cv, private RelatorioRdmRda $rdmRda, private SaldoAnterior $saldo) {}

    /** `ids` é quem o gestor marcou. Sem `ids`: todo ativo com nota ou repasse no ano, ou que carrega saldo de ano anterior. */
    public function colaboradores(int $ano, array $ids): Collection
    {
        $q = Colaborador::query()->orderBy('nome');
        if ($ids) {
            return $q->whereIn('id', array_slice($ids, 0, 200))->get();
        }
        $comNota = Nota::query()->where('deleted', false)->where('ano', $ano)->distinct()->pluck('user_id');
        $comRep = Repasse::query()->where('deleted', false)->where('ano', $ano)->distinct()->pluck('user_id');
        $carregam = $this->saldo->quemCarrega($ano);

        return $q->where('ativo', true)->whereIn('id', $comNota->merge($comRep)->merge($carregam)->unique())->get();
    }

    public function nome(string $modo, int $ano): string
    {
        return $modo === 'zip' ? "Planilhas_CV_Equipe_{$ano}.zip" : "Planilha_CV_Equipe_{$ano}.xlsx";
    }

    /** Grava em $destino. Quem chama cuida do arquivo; os temporários saem daqui. */
    public function gerar(Collection $colabs, int $ano, string $modo, string $destino): void
    {
        if ($modo === 'unico') {
            $ss = $this->cv->gerarUnico($colabs, $ano);
            $this->cv->xlsxSemCalculo($ss, $destino);
            $ss->disconnectWorksheets();

            return;
        }

        $zip = new ZipArchive;
        if ($zip->open($destino, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new RuntimeException('Não consegui criar o ZIP');
        }
        $temps = [];
        try {
            /* o mesmo RESUMO do Excel único, como arquivo próprio no ZIP */
            $tmp = $this->temporario($temps);
            $ss = new Spreadsheet;
            $ss->removeSheetByIndex(0);
            $this->cv->abaResumo($ss, $colabs, $ano);
            $this->cv->xlsxSemCalculo($ss, $tmp);
            $ss->disconnectWorksheets();
            $zip->addFile($tmp, "Resumo_Geral_{$ano}.xlsx");

            foreach ($colabs as $c) {
                $nome = preg_replace('/[^A-Za-z0-9_-]+/', '_', trim($c->nome ?: 'colaborador'));
                $tmp = $this->temporario($temps);
                if ($c->usaCartao()) {
                    $ss = $this->cv->gerar($c, $ano);
                    $this->cv->xlsx($ss, $tmp);
                    $rotulo = 'CV';
                } else {
                    $ss = $this->rdmRda->gerar($c, $ano);
                    $this->rdmRda->xlsx($ss, $tmp);
                    $rotulo = 'RDM_RDA';
                }
                $ss->disconnectWorksheets();
                unset($ss);
                $zip->addFile($tmp, "Planilha_{$rotulo}_{$nome}_{$ano}.xlsx");
            }
            $zip->close();   // é aqui que os arquivos são lidos e gravados no zip
        } finally {
            foreach ($temps as $t) {
                @unlink($t);
            }
        }
    }

    private function temporario(array &$temps): string
    {
        $base = tempnam(sys_get_temp_dir(), 'cv_');
        @unlink($base);
        $temps[] = $base.'.xlsx';

        return $base.'.xlsx';
    }
}
