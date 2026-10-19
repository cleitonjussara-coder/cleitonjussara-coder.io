<?php

namespace App\Services;

use App\Models\Justificativa;
use Illuminate\Support\Facades\Log;
use Resend\Laravel\Facades\Resend;
use Throwable;

/**
 * Avisos do pedido de justificativa (19/10/2026): notificação no celular (Web Push) e
 * e-mail (Resend, o mesmo do repasse). O aviso DENTRO do app é o sino, que lê a tabela.
 *
 * Regra herdada do e-mail de repasse: falha no envio NUNCA impede o registro. O pedido e
 * a resposta já estão gravados; o aviso é a parte frágil, então só registra o motivo
 * (email_erro / log) e segue.
 */
class JustificativaAviso
{
    public function __construct(private PushService $push) {}

    /** Gestor pediu → avisa o colaborador (celular + e-mail). */
    public function pedido(Justificativa $j): void
    {
        $j->loadMissing(['colaborador', 'autor']);
        $alvo = $j->colaborador;
        $autor = $j->autor?->nome ?: 'A gestão';
        if (! $alvo) {
            return;
        }

        try {
            $this->push->enviar($alvo, 'Justificativa solicitada', "{$autor} pede uma justificativa: ".$this->curto($j->motivo, 110), './?abrir=sino', 'justificativa-'.$j->id);
        } catch (Throwable $e) {
            Log::warning('push de justificativa falhou: '.$e->getMessage());
        }

        $app = config('petermann.front_url');
        $texto = "Olá, {$alvo->nome}.\n\n{$autor} pediu uma justificativa pelo app Petermann & Morais.\n\n"
            ."Motivo: {$j->motivo}\n"
            .($j->mensagem ? "Mensagem: {$j->mensagem}\n" : '')
            ."\nPara responder: abra o app ({$app}), toque no sino 🔔 no topo e use o botão \"Responder\".\n"
            ."Sua resposta chega direto para {$autor}.";

        [$ok, $erro] = $this->enviarEmail($alvo->email, $j->autor?->email, 'Pedido de justificativa — Petermann & Morais', $texto);
        $j->forceFill(['email_enviado' => $ok, 'email_erro' => $erro])->saveQuietly();
    }

    /** Colaborador respondeu → avisa quem pediu (celular + e-mail). */
    public function resposta(Justificativa $j): void
    {
        $j->loadMissing(['colaborador', 'autor']);
        $quem = $j->colaborador?->nome ?: 'O colaborador';
        /* Só é "quem pediu" para efeito de aviso se AINDA gerencia e está ativo. Rebaixado a colaborador/contador,
           desativado ou excluído: a resposta (que pode ser pessoal) não vai para ele — nem push nem e-mail — e a
           gestão atual é avisada; o sino dela mostra a resposta (JustificativaController::sino). */
        $autor = $j->autor;
        $autorValido = $autor && $autor->ativo && $autor->gerencia();

        try {
            $titulo = 'Justificativa respondida';
            $corpo = "{$quem} respondeu: ".$this->curto((string) $j->resposta, 110);
            if ($autorValido) {
                $this->push->enviar($autor, $titulo, $corpo, './?abrir=sino', 'justificativa-resp-'.$j->id);
            } else {
                $this->push->avisarGestores($titulo, $corpo, './?abrir=sino', 'justificativa-resp-'.$j->id);
            }
        } catch (Throwable $e) {
            Log::warning('push da resposta de justificativa falhou: '.$e->getMessage());
        }

        if ($autorValido && $autor->email) {
            $texto = "Olá, {$autor->nome}.\n\n{$quem} respondeu ao seu pedido de justificativa.\n\n"
                ."Motivo do pedido: {$j->motivo}\n\nResposta:\n{$j->resposta}\n\n"
                .'No app: Rastreio da equipe (ou o sino 🔔) → '.config('petermann.front_url');
            $this->enviarEmail($autor->email, $j->colaborador?->email, "Justificativa de {$quem} — Petermann & Morais", $texto);
        }
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
            Log::warning("e-mail de justificativa para {$para} falhou: ".$e->getMessage());

            return [false, mb_substr($e->getMessage(), 0, 250)];
        }
    }

    private function curto(string $t, int $max): string
    {
        $t = trim(preg_replace('/\s+/', ' ', $t) ?? $t);

        return mb_strlen($t) > $max ? mb_substr($t, 0, $max - 1).'…' : $t;
    }
}
