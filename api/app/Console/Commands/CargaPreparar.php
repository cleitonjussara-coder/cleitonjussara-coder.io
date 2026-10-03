<?php

namespace App\Console\Commands;

use App\Models\Colaborador;
use Illuminate\Console\Command;
use Illuminate\Support\Str;

/**
 * php84 artisan carga:preparar --n=80
 *
 * Cria N colaboradores de teste (carga01@carga.test …) + 1 gestor, já
 * confirmados, e grava os tokens em storage/app/carga-tokens.json para o
 * script scripts/carga/teste-carga.mjs. Só roda fora da produção: o teste de
 * carga jamais pode encostar nos dados reais.
 */
class CargaPreparar extends Command
{
    protected $signature = 'carga:preparar {--n=80 : quantos colaboradores}';

    protected $description = 'Cria usuários de teste e tokens para o teste de carga (só homologação)';

    public function handle(): int
    {
        if (app()->environment('production')) {
            $this->error('Recusado: este ambiente é produção.');

            return self::FAILURE;
        }

        $n = max(1, (int) $this->option('n'));
        $agora = now();
        $lista = [];

        $criar = function (string $email, string $nome, string $role) use ($agora, &$lista) {
            $u = Colaborador::where('email', $email)->first() ?? new Colaborador(['id' => (string) Str::uuid()]);
            $u->fill([
                'nome' => $nome, 'email' => $email, 'role' => $role, 'ativo' => true,
                'password' => Str::random(24), 'nucleo' => 'Cristalina',
                'regime' => 'rdm_rda', 'criado_via' => 'carga',
            ]);
            if (Colaborador::temConfirmacao()) {
                $u->confirmado_em = $agora;
            }
            $u->save();
            $u->tokens()->delete();
            $lista[] = ['id' => $u->id, 'email' => $email, 'role' => $role, 'token' => $u->createToken('carga')->plainTextToken];
        };

        $criar('carga-gestor@carga.test', 'Carga Gestor', 'gestor');
        for ($i = 1; $i <= $n; $i++) {
            $criar(sprintf('carga%02d@carga.test', $i), sprintf('Carga Colaborador %02d', $i), 'colaborador');
        }

        $arq = storage_path('app/carga-tokens.json');
        file_put_contents($arq, json_encode($lista, JSON_PRETTY_PRINT));
        $this->info(count($lista)." usuários prontos. Tokens em {$arq}");

        return self::SUCCESS;
    }
}
