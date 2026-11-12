<?php

namespace App\Console\Commands;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use App\Services\PushService;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;

/**
 * php84 artisan campo:verificar
 *
 * Linha sugerida no crontab da Locaweb (a cada 30 min):
 *   0,30 * * * * /usr/bin/php84 /home/.../api-petermann/artisan campo:verificar
 *
 * Segurança da equipe (11/11/2026, pedido do Cleiton): a atividade em campo serve para a empresa achar o colaborador
 * se ele passar mal dentro do campo. Quem iniciou um campo e está há muitas horas sem finalizar gera um aviso no
 * celular de quem acompanha (gestor, admin e focal), com fazenda, campo e hora do início, para alguém ligar e
 * confirmar que está tudo bem. Cada atividade avisa uma vez só (marca no cache por 3 dias).
 *
 * Só olha início das últimas 24 h: um campo esquecido aberto há dias não é emergência e viraria ruído.
 */
class CampoVerificar extends Command
{
    private const TZ = 'America/Sao_Paulo';

    protected $signature = 'campo:verificar {--horas=4 : em campo há mais que isto, sem finalizar, avisa}';

    protected $description = 'Avisa quem acompanha o campo quando alguém está em campo há muito tempo sem finalizar';

    public function handle(PushService $push): int
    {
        $horas = max(1, (float) $this->option('horas'));
        $agora = Carbon::now(self::TZ);
        /* o banco guarda a hora de parede de Brasília: comparar com strings no mesmo formato */
        $limite = $agora->copy()->subMinutes((int) round($horas * 60))->format('Y-m-d H:i:s');
        $desde = $agora->copy()->subHours(24)->format('Y-m-d H:i:s');

        $abertas = AtividadeCampo::query()->vivos()->whereNull('fim')
            ->where('inicio', '<=', $limite)->where('inicio', '>=', $desde)
            ->with('colaborador:id,nome,email,ativo')->orderBy('inicio')->get()
            ->filter(fn (AtividadeCampo $a) => $a->colaborador && $a->colaborador->ativo
                && ! Cache::has('campo-alerta-'.$a->id));

        if ($abertas->isEmpty()) {
            $this->info('Ninguém em campo há mais de '.$this->horasTxt($horas).' sem finalizar.');

            return self::SUCCESS;
        }

        $quemAcompanha = Colaborador::where('ativo', true)->get()->filter->acompanhaCampo();

        foreach ($abertas as $a) {
            $inicio = Carbon::parse($a->inicio->format('Y-m-d H:i:s'), self::TZ);
            $ha = (int) floor($inicio->diffInMinutes($agora, true) / 60);
            $nome = $a->colaborador->nome ?: $a->colaborador->email;
            /* o próprio colaborador não recebe o aviso sobre si mesmo (gestor/focal que também vai a campo) */
            $destino = $quemAcompanha->reject(fn (Colaborador $c) => $c->id === $a->user_id);

            $entregues = $push->enviar($destino,
                "⚠️ {$nome} em campo há {$ha} h",
                "{$a->fazenda} · campo {$a->campo}, desde ".$inicio->format('H:i').'. Ainda sem fim registrado: ligue para confirmar se está tudo bem.',
                './?abrir=campo',
                'campo-longo-'.$a->id,
            );
            Cache::put('campo-alerta-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
            $this->line(sprintf('  %-28s %s · %s desde %s (%d h) → %d aparelho(s)',
                mb_substr($nome, 0, 28), $a->fazenda, $a->campo, $inicio->format('d/m H:i'), $ha, $entregues));
        }

        $this->info($abertas->count().' aviso(s) de campo longo enviado(s).');

        return self::SUCCESS;
    }

    private function horasTxt(float $h): string
    {
        return rtrim(rtrim(number_format($h, 1, ',', ''), '0'), ',').' h';
    }
}
