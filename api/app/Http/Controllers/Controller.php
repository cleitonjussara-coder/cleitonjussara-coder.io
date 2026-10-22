<?php

namespace App\Http\Controllers;

abstract class Controller
{
    /**
     * Arquivo temporário com extensão, sem sobra (22/10/2026). tempnam() já CRIA o arquivo "fat_XXXX" (0 byte); somar
     * ".xlsx" ao nome e gravar nele deixava o original vazio para trás a cada download. Aqui o próprio arquivo criado
     * ganha a extensão — continua único e não sobra nada além do que o download apaga.
     */
    protected function temporario(string $prefixo, string $ext): string
    {
        $base = tempnam(sys_get_temp_dir(), $prefixo);
        $arquivo = $base.'.'.$ext;
        if (! @rename($base, $arquivo)) {
            @unlink($base);
        }

        return $arquivo;
    }
}
