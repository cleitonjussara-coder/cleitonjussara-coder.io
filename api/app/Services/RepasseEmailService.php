<?php

namespace App\Services;

use App\Models\Repasse;
use App\Models\RepasseEmail;
use Illuminate\Support\Facades\Log;
use Resend\Laravel\Facades\Resend;
use Throwable;

/**
 * E-mail da solicitação de repasse — o que o gatilho enviar_email_repasse
 * fazia no Postgres com pg_net + Resend.
 *
 * Regras herdadas do gatilho (não mexer sem ler o histórico lá):
 *   • só kind = 'requested', só viva, só a que ainda não saiu;
 *   • quem sabe se já saiu é o SERVIDOR (email_sent gravado aqui), nunca o
 *     app: a cópia local pode estar com false depois de o e-mail ter ido, e
 *     todo re-push reenviaria;
 *   • falha no envio NUNCA impede a gravação do repasse. Registra o motivo
 *     em repasse_emails e segue.
 */
class RepasseEmailService
{
    /** Chame DEPOIS de salvar o repasse. Devolve true se enviou agora. */
    public function enviarSePreciso(Repasse $rep): bool
    {
        if ($rep->kind !== 'requested' || $rep->deleted || $rep->email_sent) {
            return false;
        }

        $colab = $rep->dono;
        $valor = number_format((float) $rep->valor, 2, ',', '.');
        $data = $rep->data ? $rep->data->format('d/m/Y') : '';
        $nome = trim((string) ($colab?->nome ?: '')) ?: 'Colaborador';
        $email = (string) ($colab?->email ?: '');

        $texto = "Olá,\n\nSolicito o repasse referente à despesa {$rep->tipo}.\n\n"
            ."Detalhes:\n- Tipo: {$rep->tipo}\n- Valor: R$ {$valor}\n- Data: {$data}\n"
            ."- Período: {$rep->mes}/{$rep->ano}\n- Descrição: ".($rep->descricao ?: 'Sem descrição')."\n\n"
            ."Atenciosamente,\n{$nome}\n{$email}";

        $payload = array_filter([
            'from' => config('petermann.repasse.from'),
            'to' => [config('petermann.repasse.to')],
            'reply_to' => $email ?: null,
            'subject' => "Solicitação de repasse {$rep->tipo} - {$rep->mes}/{$rep->ano}",
            'text' => $texto,
        ]);

        try {
            if (! config('resend.api_key')) {
                throw new \RuntimeException('RESEND_API_KEY não configurada');
            }
            $resposta = Resend::emails()->send($payload);
            RepasseEmail::create([
                'repasse_id' => $rep->id,
                'provider_id' => $resposta['id'] ?? null,
            ]);
            /* Sem disparar updated_at de novo nem passar pelo fillable. */
            Repasse::whereKey($rep->id)->update(['email_sent' => true]);
            $rep->email_sent = true;

            return true;
        } catch (Throwable $e) {
            Log::warning("enviar_email_repasse ({$rep->id}): ".$e->getMessage());
            try {
                RepasseEmail::create(['repasse_id' => $rep->id, 'erro' => $e->getMessage()]);
            } catch (Throwable) {
                // se até o registro falhar, fica só o log
            }

            return false;
        }
    }
}
