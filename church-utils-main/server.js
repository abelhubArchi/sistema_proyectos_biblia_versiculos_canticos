const express = require("express");
const fs = require("fs");
const path = require("path");
const morgan = require("morgan");
const os = require("os");
const http = require("http");
const { Server } = require("socket.io");
const buscador = require("./src/buscador");
const himnos = require("./src/himnos");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Función para dividir de forma inteligente la letra en estrofas lógicas
function dividirEnEstrofas(letraCompleta) {
    if (!letraCompleta) return [];
    const lines = letraCompleta.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const estrofas = [];
    let currentEstrofa = [];
    let inChorus = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const prevLine = i > 0 ? lines[i - 1] : null;

        let shouldStartNew = false;

        if (i > 0) {
            // 1. Si la línea es un indicador de coro
            if (/^coro:?/i.test(line)) {
                shouldStartNew = true;
                inChorus = true;
            }
            // 2. Si la línea empieza con un número de estrofa
            else if (/^\d+[\s.)-]/.test(line)) {
                shouldStartNew = true;
                inChorus = false;
            }
            // 3. Si la línea empieza con delimitador de repetición "//" o "///"
            else if (/^\/\/+/.test(line)) {
                shouldStartNew = true;
                inChorus = false;
            }
            // 4. Si la línea anterior terminaba con "//" o "///"
            else if (prevLine && /\/\/+[.,;:?!'"\s]*$/.test(prevLine)) {
                shouldStartNew = true;
                inChorus = false;
            }
            // 5. Si estábamos en un coro y la línea actual empieza con una letra mayúscula y la anterior termina en punto,
            // esto indica que el coro terminó y empieza otra estrofa
            else if (inChorus && currentEstrofa.length >= 2 && prevLine && /[.!?]$/.test(prevLine) && /^[A-ZÁÉÍÓÚÑ]/.test(line)) {
                shouldStartNew = true;
                inChorus = false;
            }
            // 6. Para estrofas normales, si ya tiene al menos 4 líneas y la siguiente línea empieza con mayúscula,
            // la dividimos para que no queden bloques demasiado largos en la proyección
            else if (!inChorus && currentEstrofa.length >= 4 && /^[A-ZÁÉÍÓÚÑ]/.test(line)) {
                shouldStartNew = true;
            }
        }

        if (shouldStartNew && currentEstrofa.length > 0) {
            estrofas.push(currentEstrofa.join('\n'));
            currentEstrofa = [];
        }

        currentEstrofa.push(line);
    }

    if (currentEstrofa.length > 0) {
        estrofas.push(currentEstrofa.join('\n'));
    }

    return estrofas.map((texto, idx) => ({
        numero: idx + 1,
        texto: texto
    }));
}

// Cargar cancionero.json en memoria
let cancionero = [];
try {
    const cancioneroPath = path.join(__dirname, "src", "himnarios", "cancionero.json");
    const rawData = JSON.parse(fs.readFileSync(cancioneroPath, "utf-8"));

    // Asegurar que las estrofas se dividan correctamente de forma dinámica
    cancionero = rawData.map(cantico => {
        if (cantico.letraCompleta) {
            cantico.estrofas = dividirEnEstrofas(cantico.letraCompleta);
        } else if (cantico.diapositivas && cantico.diapositivas.length > 0) {
            cantico.estrofas = cantico.diapositivas.map((texto, idx) => ({
                numero: idx + 1,
                texto: texto
            }));
        }
        return cantico;
    });

    console.log(`📚 Cargados ${cancionero.length} cánticos correctamente con estrofas optimizadas.`);
} catch (error) {
    console.error("❌ Error al cargar cancionero.json:", error);
}

// ==================== LÍNEAS PERSONALIZADAS ====================
// Archivo para persistir ediciones de líneas por cántico
const lineasOverridePath = path.join(__dirname, "src", "himnarios", "lineas-override.json");
let lineasOverride = {};

try {
    if (fs.existsSync(lineasOverridePath)) {
        lineasOverride = JSON.parse(fs.readFileSync(lineasOverridePath, "utf-8"));
        console.log(`✏️  Cargadas ediciones de líneas para ${Object.keys(lineasOverride).length} cántico(s).`);
    }
} catch (e) {
    console.error("❌ Error al cargar lineas-override.json:", e);
    lineasOverride = {};
}

function guardarLineasOverride() {
    fs.writeFile(lineasOverridePath, JSON.stringify(lineasOverride, null, 2), "utf-8", (err) => {
        if (err) console.error("❌ Error al guardar lineas-override.json:", err);
    });
}

// Función para dividir un cántico en líneas individuales (para el modo por líneas)
function dividirEnLineas(cantico) {
    const key = cantico.titulo;
    // Si hay override guardado, usarlo
    if (lineasOverride[key]) {
        return lineasOverride[key];
    }
    // Generar desde la letra completa
    const texto = cantico.letraCompleta || (cantico.estrofas || []).map(e => e.texto).join('\n');
    return texto
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map((l, i) => ({ id: i + 1, texto: l, seleccionada: true }));
}

// Helper para normalizar texto (quitar tildes y mayúsculas)
function normalizarTexto(texto) {
    return texto
        ? texto
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
        : "";
}

app.use(express.static("public"));
app.use(express.json());
app.use(morgan("dev"));

// ==================== CONFIGURACIÓN DE IP LOCAL ====================

// Obtener IP local
function obtenerIPLocal() {
    const interfaces = os.networkInterfaces();
    for (const nombre of Object.keys(interfaces)) {
        for (const iface of interfaces[nombre]) {
            // IPv4 y no localhost
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const ipLocal = obtenerIPLocal();
const puerto = 3000;

// ==================== VARIABLES GLOBALES ====================

// Almacenar la última búsqueda para mostrar en pantalla
let ultimaBusqueda = {
    texto: '',
    resultados: [],
    tipo: null,
    timestamp: null
};

// ==================== INICIO DEL SERVIDOR ====================

server.listen(puerto, () => {
    console.log("\n" + "=".repeat(70));
    console.log("✅ SERVIDOR INICIADO CORRECTAMENTE");
    console.log("=".repeat(70));
    console.log("\n  ACCESO LOCAL:");
    console.log(`   • http://localhost:${puerto}`);
    console.log(`   • http://127.0.0.1:${puerto}`);
    console.log(`   • http://${ipLocal}:${puerto}`);
    console.log("\ URLS DISPONIBLES:");
    console.log(`    Controlador (Búsqueda): http://${ipLocal}:${puerto}`);
    console.log(`    Pantalla (Display): http://${ipLocal}:${puerto}/pantalla`);
    console.log(`    App Completa (Biblia+Himnos): http://${ipLocal}:${puerto}/app`);
    console.log(`    Admin Cánticos: http://${ipLocal}:${puerto}/canticosadmin`);
    console.log(`    Pantalla Cánticos: http://${ipLocal}:${puerto}/canticospantalla`);
    console.log("\n ACCESO REMOTO (desde celular en mismo WiFi):");
    console.log(`   • http://${ipLocal}:${puerto}`);
    console.log("\n  INFORMACIÓN DEL SISTEMA:");
    console.log(`   • IP Local: ${ipLocal}`);
    console.log(`   • Puerto: ${puerto}`);
    console.log(`   • Node.js: ${process.version}`);
    console.log("\n" + "=".repeat(70) + "\n");
});

// ==================== SOCKET.IO CONFIGURACIÓN ====================
let ultimoCanticoProyectado = null;
let fondoActual = "assets/1.jpg";

// Navegación de versículos (anterior/siguiente)
let ultimoVersiculo = null;

io.on("connection", (socket) => {
    // Si ya hay un cántico proyectado en esta sesión, lo enviamos al cliente recién conectado
    if (ultimoCanticoProyectado) {
        socket.emit("cambio-estrofa", ultimoCanticoProyectado);
    }

    // Enviar el fondo actual
    socket.emit("cambiar-fondo", fondoActual);

    // Enviar el último versículo proyectado si existe
    if (ultimoVersiculo) {
        socket.emit("proyectar-versiculo", ultimoVersiculo);
    }

    socket.on("cambio-estrofa", (data) => {
        ultimoCanticoProyectado = data;
        io.emit("cambio-estrofa", data);
    });

    socket.on("cambiar-pantalla", (targetUrl) => {
        io.emit("cambiar-pantalla", targetUrl);
    });

    socket.on("cambiar-fondo", (url) => {
        fondoActual = url;
        io.emit("cambiar-fondo", url);
    });

    // Evento para proyectar un versículo específico desde el control
    socket.on("proyectar-versiculo", (data) => {
        ultimoVersiculo = data;
        io.emit("proyectar-versiculo", data);
    });

    // Evento para navegar versículos (anterior/siguiente)
    socket.on("navegar-versiculo", (direccion) => {
        io.emit("navegar-versiculo", direccion);
    });
});

// ==================== RUTAS HTML ====================

// Página principal (Controlador)
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// App completa (Versículos + Himnos)
app.get("/app", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "app.html"));
});

// Página de pantalla (Display para el salón)
app.get("/pantalla", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "pantalla.html"));
});

// Ruta del administrador de cánticos
app.get("/canticosadmin", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "canticosadmin.html"));
});

// Ruta de la pantalla de proyección de cánticos
app.get("/canticospantalla", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "canticospantalla.html"));
});

// Endpoint para obtener los fondos dinámicamente desde el directorio public/assets
app.get("/api/fondos", (req, res) => {
    const assetsDir = path.join(__dirname, "public", "assets");
    fs.readdir(assetsDir, (err, files) => {
        if (err) {
            console.error("Error al leer directorio de fondos:", err);
            return res.status(500).json({ error: "No se pudieron cargar los fondos" });
        }
        const extensionesValidas = [".jpg", ".jpeg", ".png", ".webp", ".gif", ".jfif", ".mp4"];
        const fondos = files
            .filter(file => {
                const ext = path.extname(file).toLowerCase();
                return extensionesValidas.includes(ext) && file.toLowerCase() !== "logo.png";
            })
            .map(file => ({
                url: `assets/${file}`,
                nombre: file.replace(/\.[^.]+$/, ''),
                tipo: [".mp4"].includes(path.extname(file).toLowerCase()) ? 'video' :
                    [".gif"].includes(path.extname(file).toLowerCase()) ? 'gif' : 'imagen'
            }));
        res.json(fondos);
    });
});

// ==================== API DE LÍNEAS POR CÁNTICO ====================

// Obtener líneas de un cántico (con overrides si existen)
app.get("/api/canticos/:titulo/lineas", (req, res) => {
    const titulo = decodeURIComponent(req.params.titulo);
    const cantico = cancionero.find(c => c.titulo === titulo);
    if (!cantico) {
        return res.status(404).json({ error: 'Cántico no encontrado' });
    }
    const lineas = dividirEnLineas(cantico);
    res.json({ titulo, lineas, tieneOverride: !!lineasOverride[titulo] });
});

// Guardar líneas personalizadas para un cántico
app.post("/api/canticos/:titulo/lineas", (req, res) => {
    const titulo = decodeURIComponent(req.params.titulo);
    const { lineas } = req.body;
    if (!Array.isArray(lineas)) {
        return res.status(400).json({ error: 'Se esperaba un array de líneas' });
    }
    lineasOverride[titulo] = lineas;
    guardarLineasOverride();
    res.json({ exito: true, titulo, totalLineas: lineas.length });
});

// Restaurar líneas originales (eliminar override)
app.delete("/api/canticos/:titulo/lineas", (req, res) => {
    const titulo = decodeURIComponent(req.params.titulo);
    if (lineasOverride[titulo]) {
        delete lineasOverride[titulo];
        guardarLineasOverride();
    }
    const cantico = cancionero.find(c => c.titulo === titulo);
    if (!cantico) {
        return res.status(404).json({ error: 'Cántico no encontrado' });
    }
    const lineas = dividirEnLineas(cantico);
    res.json({ exito: true, titulo, lineas });
});

// ==================== API DE CÁNTICOS ====================

app.get("/api/canticos", (req, res) => {
    const query = req.query.q;
    if (!query || query.trim() === '') {
        return res.json(cancionero);
    }
    const normalizedQuery = normalizarTexto(query);
    const resultados = cancionero.filter(cantico => {
        const tituloNorm = normalizarTexto(cantico.titulo || "");
        if (tituloNorm.includes(normalizedQuery)) return true;
        if (cantico.estrofas && Array.isArray(cantico.estrofas)) {
            return cantico.estrofas.some(est => normalizarTexto(est.texto || "").includes(normalizedQuery));
        }
        return false;
    });
    res.json(resultados);
});

// ==================== API DE VERSÍCULOS ====================

// Búsqueda inteligente de versículos
app.post("/buscar", (req, res) => {
    const { busqueda } = req.body;

    if (!busqueda || busqueda.trim() === '') {
        return res.status(400).json({
            error: true,
            mensaje: 'Debes escribir algo para buscar'
        });
    }

    const resultado = buscador.buscarInteligente(busqueda);

    // Guardar la búsqueda para que pantalla.html la muestre
    ultimaBusqueda = {
        texto: busqueda.trim(),
        resultados: resultado.resultados || [],
        tipo: resultado.tipo,
        timestamp: new Date().toISOString()
    };

    res.json({
        exito: true,
        busqueda: busqueda.trim(),
        ...resultado
    });
});

// Obtener la última búsqueda (para pantalla.html)
app.get("/api/ultima-busqueda", (req, res) => {
    res.json(ultimaBusqueda);
});

// Predicción/autocompletado (como Google)
app.post("/predicciones", (req, res) => {
    const { texto } = req.body;

    if (!texto || texto.trim() === '') {
        return res.json({ predicciones: [] });
    }

    const predicciones = buscador.obtenerPredicciones(texto);

    res.json({
        exito: true,
        predicciones: predicciones
    });
});

// Obtener versículo anterior
app.post("/api/versiculo-anterior", (req, res) => {
    const { libro, capitulo, versiculo } = req.body;

    if (!libro || !capitulo || !versiculo) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
    }

    const verso = buscador.obtenerVersiculoAnterior(libro, capitulo, versiculo);
    const info = verso ? buscador.obtenerInfoNavegacion(verso.libro, verso.capitulo, verso.versiculo) : null;

    res.json({
        exito: !!verso,
        verso,
        navegacion: info
    });
});

// Obtener versículo siguiente
app.post("/api/versiculo-siguiente", (req, res) => {
    const { libro, capitulo, versiculo } = req.body;

    if (!libro || !capitulo || !versiculo) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
    }

    const verso = buscador.obtenerVersiculoSiguiente(libro, capitulo, versiculo);
    const info = verso ? buscador.obtenerInfoNavegacion(verso.libro, verso.capitulo, verso.versiculo) : null;

    res.json({
        exito: !!verso,
        verso,
        navegacion: info
    });
});

// Obtener información de navegación de versículos
app.post("/api/info-navegacion", (req, res) => {
    const { libro, capitulo, versiculo } = req.body;

    if (!libro || !capitulo || !versiculo) {
        return res.status(400).json({ error: 'Parámetros inválidos' });
    }

    const info = buscador.obtenerInfoNavegacion(libro, capitulo, versiculo);
    res.json({
        exito: !!info,
        navegacion: info
    });
});

// ==================== API DE HIMNOS ====================

// Buscar himnos
app.post("/api/buscar-himnos", (req, res) => {
    const { busqueda } = req.body;

    if (!busqueda || busqueda.trim() === '') {
        return res.status(400).json({
            error: true,
            mensaje: 'Debes escribir algo para buscar'
        });
    }

    const resultados = himnos.buscarHimnos(busqueda);
    res.json({
        exito: true,
        resultados
    });
});

// Obtener estrofas de un himno
app.get("/api/himno/:himnario/:numero", (req, res) => {
    const { himnario, numero } = req.params;

    const resultado = himnos.obtenerEstrofas(himnario, numero);

    if (!resultado) {
        return res.status(404).json({
            error: true,
            mensaje: 'Himno no encontrado'
        });
    }

    res.json({
        exito: true,
        ...resultado
    });
});

// Obtener estrofa específica
app.get("/api/himno/:himnario/:numero/:indiceEstrofa", (req, res) => {
    const { himnario, numero, indiceEstrofa } = req.params;

    const resultado = himnos.obtenerEstrofa(himnario, numero, parseInt(indiceEstrofa));

    if (!resultado) {
        return res.status(404).json({
            error: true,
            mensaje: 'Estrofa no encontrada'
        });
    }

    res.json({
        exito: true,
        ...resultado
    });
});

// ==================== API INFORMACIÓN ====================

// Obtener índice de libros
app.get("/api/libros", (req, res) => {
    const indice = buscador.cargarIndice();
    res.json({
        exito: true,
        total: indice.length,
        libros: indice.map(libro => ({
            nombre: libro.shortTitle,
            abreviatura: libro.abbr,
            capitulos: libro.chapters || 0,
            versiculos: libro.verses || 0
        }))
    });
});

// Obtener información del servidor
app.get("/api/info", (req, res) => {
    res.json({
        servidor: 'church-utils',
        version: '1.0.0',
        ipLocal: ipLocal,
        puerto: puerto,
        urls: {
            controlador: `http://${ipLocal}:${puerto}`,
            pantalla: `http://${ipLocal}:${puerto}/pantalla`,
            app: `http://${ipLocal}:${puerto}/app`
        }
    });
});
