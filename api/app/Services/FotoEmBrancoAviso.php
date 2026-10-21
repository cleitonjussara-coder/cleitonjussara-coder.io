<?php

namespace App\Services;

use App\Models\Colaborador;
use App\Models\Nota;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Mede o anexo de uma nota (FotoEmBranco), guarda o resultado em notas.foto_em_branco e, quando a foto acaba de
 * ser considerada em branco, avisa gestor e admin no celular (Web Push; o sino e a faixa de pendências do app
 * leem a coluna). 21/10/2026.
 *
 * Regra herdada do aviso de repasse/justificativa: NADA aqui pode atrapalhar o envio da nota. Qualquer erro vira
 * um log e a nota segue gravada como o app mandou. E nada é apagado nem recusado — só marcado.
 */
class FotoEmBrancoAviso
{
    /** Acima disto (bytes) o arquivo nem é lido: o GD não daria conta dentro dos 128 MB do PHP. */
    private const MAX_BYTES = 25_000_000;

    public function __construct(private FotoStorage $fotos, private PushService $push) {}

    /**
     * Analisa o anexo e grava o resultado. Devolve true (em branco), false (tem conteúdo ou não é imagem que dê para
     * medir) ou null (sem coluna ainda, sem anexo ou arquivo ausente: nada foi gravado).
     *
     * $refazer: o anexo acabou de ser trocado — mede de novo mesmo que já houvesse resultado.
     * $avisar:  falso no mutirão sobre notas antigas (o sino mostra; push para nota velha seria barulho).
     */
    public function avaliar(Nota $nota, ?Colaborador $autor = null, bool $refazer = false, bool $avisar = true): ?bool
    {
        try {
            if (! Nota::temFotoEmBranco() || ! $nota->foto_path) {
                return null;
            }
            if (! $refazer && $nota->foto_em_branco !== null) {
                return (bool) $nota->foto_em_branco;
            }

            $resultado = $this->medir($nota->foto_path);
            if ($resultado === null) {
                return null;
            }

            $era = $nota->foto_em_branco;
            if ($era !== $resultado) {
                $nota->forceFill(['foto_em_branco' => $resultado])->save();
            }
            if ($resultado && $era !== true && $avisar) {
                $this->avisarGestores($nota, $autor);
            }

            return $resultado;
        } catch (Throwable $e) {
            Log::warning('foto em branco: análise falhou', ['nota' => $nota->id, 'erro' => $e->getMessage()]);

            return null;
        }
    }

    /** true = em branco; false = tem conteúdo ou não é imagem medível (PDF, XML, HEIC); null = arquivo ausente. */
    public function medir(string $path): ?bool
    {
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        if (! in_array($ext, FotoEmBranco::EXTS_IMAGEM, true)) {
            return false;
        }
        if (! $this->fotos->existe($path)) {
            return null;
        }
        if ($this->fotos->disk()->size($path) > self::MAX_BYTES) {
            return false;
        }

        return FotoEmBranco::emBranco($this->fotos->disk()->get($path)) === true;
    }

    private function avisarGestores(Nota $nota, ?Colaborador $autor): void
    {
        try {
            $dono = $nota->user_id ? Colaborador::find($nota->user_id) : null;
            $quem = $dono?->nome ?: ($autor?->nome ?: 'Alguém');
            $resumo = implode(' · ', array_filter([
                $nota->razao_social ?: null,
                $nota->tipo,
                'R$ '.number_format((float) $nota->valor, 2, ',', '.'),
            ]));
            /* quem enviou a nota não precisa do próprio aviso (gestor lançando para um colaborador) */
            $gestores = Colaborador::whereIn('role', ['gestor', 'admin'])->where('ativo', true)
                ->when($autor, fn ($q) => $q->where('id', '<>', $autor->id))->get();

            $this->push->enviar($gestores, 'Foto em branco numa nota', "{$quem} enviou uma nota com a foto em branco: {$resumo}", './?abrir=sino', 'foto-branca-'.$nota->id);
        } catch (Throwable $e) {
            Log::warning('push de foto em branco falhou: '.$e->getMessage());
        }
    }
}
