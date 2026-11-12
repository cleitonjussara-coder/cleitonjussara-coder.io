<?php

namespace App\Console\Commands;

use App\Models\AtividadeCampo;
use App\Models\Colaborador;
use App\Services\PushService;
use Carbon\Carbon;
use Illuminate\Console\Command;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;

/**
 * php84 artisan campo:verificar
 *
 * Linha sugerida no crontab da Locaweb (a cada 30 min):
 *   0,30 * * * * /usr/bin/php84 /home/.../api-petermann/artisan campo:verificar
 *
 * Acompanhamento solidário (11/11/2026, pedido do Cleiton): a atividade em campo serve para a empresa achar o
 * colaborador se ele passar mal dentro do campo. Quem iniciou um campo e está há muitas horas sem finalizar gera
 * aviso no celular, para alguém ligar e confirmar que está tudo bem.
 *
 * Quem recebe (decisão do Cleiton): o FOCAL está à frente do acompanhamento da equipe.
 *   • com --horas (4 h): só o focal;
 *   • com --escalar (6 h), se continua aberto: o gestor também (gestor e admin);
 *   • sem nenhum focal ativo: o gestor já recebe com 4 h (e não recebe de novo com 6 h).
 * Cada etapa avisa uma vez por atividade (marca no cache por 3 dias). Só olha início das últimas 24 h: campo esquecido
 * aberto há dias não é emergência e viraria ruído. Quem está em campo não recebe aviso sobre si mesmo.
 */
class CampoVerificar extends Command
{
    private const TZ = 'America/Sao_Paulo';

    protected $signature = 'campo:verificar
        {--horas=4 : em campo há mais que isto, sem finalizar, avisa o focal}
        {--escalar=6 : continua aberto depois disto, avisa também o gestor}';

    protected $description = 'Acompanhamento solidário: avisa o focal (e depois o gestor) quando alguém está em campo há muito tempo';

    public function handle(PushService $push): int
    {
        $horas = max(1, (float) $this->option('horas'));
        $escalar = max($horas, (float) $this->option('escalar'));
        $agora = Carbon::now(self::TZ);
        /* o banco guarda a hora de parede de Brasília: comparar com strings no mesmo formato */
        $limite = $agora->copy()->subMinutes((int) round($horas * 60))->format('Y-m-d H:i:s');
        $desde = $agora->copy()->subHours(24)->format('Y-m-d H:i:s');

        $abertas = AtividadeCampo::query()->vivos()->whereNull('fim')
            ->where('inicio', '<=', $limite)->where('inicio', '>=', $desde)
            ->with('colaborador:id,nome,email,ativo')->orderBy('inicio')->get()
            ->filter(fn (AtividadeCampo $a) => $a->colaborador && $a->colaborador->ativo);

        $ativos = Colaborador::where('ativo', true)->get();
        $gestores = $ativos->filter->gerencia()->values();
        $focais = $ativos->filter(fn (Colaborador $c) => ! $c->gerencia() && $c->acompanhaCampo())->values();
        $avisos = 0;

        foreach ($abertas as $a) {
            $inicio = Carbon::parse($a->inicio->format('Y-m-d H:i:s'), self::TZ);
            $min = (int) $inicio->diffInMinutes($agora, true);
            $semEle = fn (Collection $l) => $l->reject(fn (Colaborador $c) => $c->id === $a->user_id)->values();
            $focal = $semEle($focais);
            $gestor = $semEle($gestores);

            if (! Cache::has('campo-alerta-'.$a->id)) {
                /* 1ª etapa: o focal; sem focal, já vai para o gestor */
                $semFocal = $focal->isEmpty();
                $this->avisar($push, $a, $inicio, $min, $semFocal ? $gestor : $focal, $semFocal ? 'gestor (sem focal)' : 'focal');
                Cache::put('campo-alerta-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
                if ($semFocal) {
                    Cache::put('campo-alerta-gestor-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
                }
                $avisos++;
            } elseif ($min >= $escalar * 60 && ! Cache::has('campo-alerta-gestor-'.$a->id)) {
                /* 2ª etapa: continua aberto, o gestor entra */
                $this->avisar($push, $a, $inicio, $min, $gestor, 'gestor');
                Cache::put('campo-alerta-gestor-'.$a->id, $agora->toIso8601String(), now()->addDays(3));
                $avisos++;
            }
        }

        $this->info($avisos ? $avisos.' aviso(s) de campo longo enviado(s).' : 'Nenhum aviso novo de campo longo.');

        return self::SUCCESS;
    }

    private function avisar(PushService $push, AtividadeCampo $a, Carbon $inicio, int $min, Collection $destino, string $para): void
    {
        $ha = intdiv($min, 60);
        $nome = $a->colaborador->nome ?: $a->colaborador->email;
        $entregues = $destino->isEmpty() ? 0 : $push->enviar($destino,
            "⚠️ {$nome} em campo há {$ha} h",
            "{$a->fazenda} · campo {$a->campo}, desde ".$inicio->format('H:i').'. Ainda sem fim registrado: ligue para confirmar se está tudo bem.',
            './?abrir=campo',
            'campo-longo-'.$a->id,
        );
        $this->line(sprintf('  %-28s %s · %s desde %s (%d h) → %s: %d aparelho(s)',
            mb_substr($nome, 0, 28), $a->fazenda, $a->campo, $inicio->format('d/m H:i'), $ha, $para, $entregues));
    }
}
