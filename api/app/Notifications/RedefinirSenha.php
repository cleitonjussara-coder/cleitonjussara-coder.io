<?php

namespace App\Notifications;

use Illuminate\Notifications\Messages\MailMessage;
use Illuminate\Notifications\Notification;

/**
 * E-mail do "Esqueci minha senha". O link abre o próprio app com
 * ?reset=<token>&email=<e-mail>; o app mostra a tela "Nova senha" e chama
 * POST /auth/reset. Vale 60 min e uma vez só (config/auth.php → passwords).
 */
class RedefinirSenha extends Notification
{
    public function __construct(public string $token) {}

    public function via(object $notifiable): array
    {
        return ['mail'];
    }

    public function toMail(object $notifiable): MailMessage
    {
        $url = config('petermann.front_url').'/?'.http_build_query([
            'reset' => $this->token,
            'email' => $notifiable->getEmailForPasswordReset(),
        ]);

        return (new MailMessage)
            ->subject('Petermann App — redefinir senha')
            ->greeting('Olá!')
            ->line('Recebemos um pedido para redefinir a senha da sua conta no Petermann App.')
            ->action('Definir nova senha', $url)
            ->line('O link vale por 1 hora e só pode ser usado uma vez.')
            ->line('Se não foi você, ignore este e-mail — a senha continua a mesma.')
            ->salutation('Petermann App');
    }
}
