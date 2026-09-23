<?php

namespace App\Console\Commands;

use App\Services\FotoStorage;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * php84 artisan fotos:endireitar [--seco]
 *
 * Mutirão nas fotos que já estão no servidor (23/09/2026): celular grava a
 * imagem deitada e escreve "gire tanto" só no EXIF. O app mostrava certo,
 * mas o arquivo ia deitado para o PDF, o ZIP e a planilha. Aqui cada JPEG
 * com orientação diferente de 1 é regravado já rotacionado, e a miniatura
 * velha é apagada para nascer de novo.
 *
 * --seco apenas conta, sem gravar.
 */
class FotosEndireitar extends Command
{
    protected $signature = 'fotos:endireitar {--seco : só mostra quantas precisam}';

    protected $description = 'Regrava as fotos guardadas já na posição certa (assa a rotação do EXIF)';

    public function handle(FotoStorage $fotos): int
    {
        $disk = $fotos->disk();
        $seco = (bool) $this->option('seco');
        $tot = 0;
        $mexidas = 0;

        foreach ($disk->allFiles() as $path) {
            $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            if (! in_array($ext, ['jpg', 'jpeg'], true)) {
                continue;
            }
            if (str_contains(str_replace('\\', '/', $path), '/'.FotoStorage::MINI_DIR.'/')) {
                continue;   // miniatura é refeita sozinha
            }
            $tot++;
            if ($seco) {
                try {
                    $exif = @exif_read_data('data://image/jpeg;base64,'.base64_encode($disk->get($path)));
                    if ((int) ($exif['Orientation'] ?? 1) > 1) {
                        $mexidas++;
                        $this->line('  deitada: '.$path);
                    }
                } catch (\Throwable) {
                }

                continue;
            }
            if ($fotos->endireitar($path)) {
                $mexidas++;
                $this->line('  endireitada: '.$path);
            }
        }

        $msg = $seco
            ? "fotos: {$mexidas} de {$tot} precisam ser endireitadas (nada foi gravado)"
            : "fotos: {$mexidas} de {$tot} endireitadas";
        $this->info($msg);
        Log::info($msg);

        return self::SUCCESS;
    }
}
