<?php

namespace App\Services;

use App\Models\AvisoCorrecao;
use Illuminate\Support\Facades\Log;
use Resend\Laravel\Facades\Resend;
use Throwable;

/**
 * Avisos do pedido de correção de nota (24/10/2026): notificação no celular (Web Push) e e-mail (Resend, o mesmo do
 * repasse e da justificativa). O aviso DENTRO do app é o sino, que lê a tabela.
 *
 * Regra herdada dos outros avisos: falha no envio NUNCA impede o registro. O aviso já está gravado; o envio é a parte
 * frágil, então só registra o motivo (email_erro / log) e segue.
 */
class AvisoCorrecaoAviso
{
    public function __construct(private PushService $push) {}

    /** Gestor avisou → avisa o dono da nota (celular + e-mail). */
    public function enviar(AvisoCorrecao $a): void
    {
        $a->loadMissing(['colaborador', 'autor']);
        $alvo = $a->colaborador;
        $autor = $a->autor?->nome ?: 'A gestão';
        if (! $alvo) {
            return;
        }

        /* Agrupamento (revisão de 24/10/2026): o gestor que percorre o quadro avisando nota por nota geraria uma vibração e um
           e-mail por nota. Se este colaborador JÁ foi notificado (celular/e-mail) há menos de N minutos, o aviso novo entra só no
           sino. A janela conta a partir do último aviso que notificou, não dos agrupados — senão a fila nunca terminaria. */
        $janela = max(0, (int) config('petermann.aviso_correcao.agrupar_minutos', 10));
        if ($janela > 0 && AvisoCorrecao::where('colaborador_id', $alvo->id)->where('id', '!=', $a->id)->where('agrupado', false)
            ->where('created_at', '>=', now()->subMinutes($janela))->exists()) {
            $a->forceFill(['agrupado' => true])->saveQuietly();

            return;
        }

        $quais = implode(', ', $a->motivos ?? []);
        $nota = $a->nota_titulo ?: 'uma nota';

        try {
            $corpo = "{$autor} pede para corrigir a nota {$nota}".($quais !== '' ? " ({$quais})" : '').'.'.($a->mensagem ? ' '.$a->mensagem : '');
            /* a tag é por colaborador: vários avisos seguidos viram UMA notificação no celular (a última); no sino ficam todos */
            $this->push->enviar($alvo, 'Corrija uma nota', $this->curto($corpo, 140), './?abrir=sino', 'correcao-'.$alvo->id);
        } catch (Throwable $e) {
            Log::warning('push de aviso de correção falhou: '.$e->getMessage());
        }

        $app = config('petermann.front_url');
        $texto = "Olá, {$alvo->nome}.\n\n{$autor} pede que você corrija uma nota no app Petermann & Morais.\n\n"
            ."Nota: {$nota}".($a->nota_data ? ' — '.$this->dataBr($a->nota_data) : '').($a->nota_valor !== null ? ' — R$ '.number_format($a->nota_valor, 2, ',', '.') : '')."\n"
            .($quais !== '' ? "O que falta: {$quais}\n" : '')
            .($a->mensagem ? "Mensagem: {$a->mensagem}\n" : '')
            ."\nPara corrigir: abra o app ({$app}), toque no sino 🔔 no topo e use o botão \"Corrigir a nota\".";

        [$ok, $erro] = $this->enviarEmail($alvo->email, $a->autor?->email, 'Corrija uma nota — Petermann & Morais', $texto);
        $a->forceFill(['email_enviado' => $ok, 'email_erro' => $erro])->saveQuietly();
    }

    /** @return array{0: bool, 1: ?string} [enviou, motivo da falha] */
    private function enviarEmail(?string $para, ?string $responderPara, string $assunto, string $texto): array
    {
        if (! $para) {
            return [false, 'destinatário sem e-mail'];
        }
        try {
            if (! config('resend.api_key')) {
                throw new \RuntimeException('RESEND_API_KEY não configurada');
            }
            Resend::emails()->send(array_filter([
                'from' => config('petermann.repasse.from'),
                'to' => [$para],
                'reply_to' => $responderPara ?: null,
                'subject' => $assunto,
                'text' => $texto,
            ]));

            return [true, null];
        } catch (Throwable $e) {
            Log::warning("e-mail de aviso de correção para {$para} falhou: ".$e->getMessage());

            return [false, mb_substr($e->getMessage(), 0, 250)];
        }
    }

    private function dataBr(string $iso): string
    {
        $p = explode('-', substr($iso, 0, 10));

        return count($p) === 3 ? "{$p[2]}/{$p[1]}/{$p[0]}" : $iso;
    }

    private function curto(string $t, int $max): string
    {
        $t = trim(preg_replace('/\s+/', ' ', $t) ?? $t);

        return mb_strlen($t) > $max ? mb_substr($t, 0, $max - 1).'…' : $t;
    }
}
