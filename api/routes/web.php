<?php

use Illuminate\Support\Facades\Route;

/* A API não tem páginas; a raiz só diz que está no ar. */
Route::get('/', fn () => response()->json(['app' => 'Petermann API', 'ok' => true]));
