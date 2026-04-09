// ==========================================
// CAPA 1: IMPORTACIONES Y CONFIGURACIÓN BASE
// ==========================================
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const app = express();

// CAMBIO PARA LA NUBE 1: El puerto ahora es dinámico
const puerto = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// CAMBIO PARA LA NUBE 2: Le decimos a Node que sirva los HTML desde la carpeta "public"
app.use(express.static('public'));

// ==========================================
// CAPA 2: CONEXIÓN A LA BASE DE DATOS
// ==========================================
// CAMBIO PARA LA NUBE 3: Variables de entorno ocultas
const conexion = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'jazer',      
    password: process.env.DB_PASSWORD || '26122000!',      
    database: process.env.DB_NAME || 'ferreteria_inventario',
    port: process.env.DB_PORT || 3306
});

conexion.connect((error) => {
    if (error) {
        console.error('❌ Error conectando a MySQL:', error.message);
        return;
    }
    console.log('✅ ¡Conectado exitosamente a la base de datos de la ferretería!');
});

// ==========================================
// CAPA 3: MIDDLEWARES (Los Guardias)
// ==========================================
const verificarToken = (req, res, next) => {
    const tokenHeader = req.header('Authorization');
    if (!tokenHeader) {
        return res.status(401).json({ mensaje: 'Acceso denegado. Necesitas iniciar sesión.' });
    }
    try {
        const tokenLimpio = tokenHeader.replace('Bearer ', '');
        const verificado = jwt.verify(tokenLimpio, 'secreto_ferreteria');
        req.usuario = verificado;
        next(); 
    } catch (error) {
        return res.status(401).json({ mensaje: 'Tu sesión ha expirado o el token es inválido.' });
    }
};

// ==========================================
// CAPA 4: RUTAS PÚBLICAS Y LOGIN
// ==========================================
app.get('/', (req, res) => {
    res.send('¡Hola! El motor del sistema está funcionando a la perfección en la nube.');
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;

    if (username === 'admin_ferreteria' && password === 'gym2026') {
        const token = jwt.sign({ rol: 'admin' }, 'secreto_ferreteria', { expiresIn: '2h' });
        return res.json({ mensaje: '¡Bienvenido Administrador!', token: token, rol: 'admin', pantallas_permitidas: ['panel_administracion', 'punto_de_venta'] });
    }
    
    if (username === 'caja_gym' && password === 'ventas2026') {
        const token = jwt.sign({ rol: 'cajero' }, 'secreto_ferreteria', { expiresIn: '8h' });
        return res.json({ mensaje: '¡Bienvenido a Caja!', token: token, rol: 'cajero', pantallas_permitidas: ['punto_de_venta'] });
    }

    res.status(401).send('Usuario o contraseña incorrectos');
});

// ==========================================
// CAPA 5: INVENTARIO Y PRODUCTOS
// ==========================================
app.get('/productos', (req, res) => {
    conexion.query('SELECT * FROM Productos', (error, resultados) => {
        if (error) return res.status(500).send('Error');
        res.json(resultados);
    });
});

app.get('/inventario', (req, res) => {
    const consultaSQL = `SELECT p.id_producto, p.sku, p.nombre, p.tipo_unidad, i.cantidad_disponible, i.precio_compra, i.precio_venta FROM Productos p JOIN Inventario_Actual i ON p.id_producto = i.id_producto`;
    conexion.query(consultaSQL, (error, resultados) => {
        if (error) return res.status(500).send('Error');
        res.json(resultados);
    });
});

app.post('/productos', verificarToken, (req, res) => {
    const { sku, nombre, descripcion, id_categoria, tipo_unidad, stock_minimo, cantidad, precio_compra, precio_venta } = req.body;
    const queryProducto = `INSERT INTO Productos (sku, nombre, descripcion, id_categoria, tipo_unidad, stock_minimo) VALUES (?, ?, ?, ?, ?, ?)`;
    conexion.query(queryProducto, [sku, nombre, descripcion, id_categoria, tipo_unidad, stock_minimo], (errP, resP) => {
        if (errP) return res.status(500).send('Error al insertar producto central');
        const idNuevo = resP.insertId;
        conexion.query(`INSERT INTO Inventario_Actual (id_producto, cantidad_disponible, precio_compra, precio_venta) VALUES (?, ?, ?, ?)`, [idNuevo, cantidad, precio_compra, precio_venta], (errI) => {
            if (errI) return res.status(500).send('Error al insertar en inventario');
            conexion.query(`INSERT INTO Kardex_Movimientos (id_producto, tipo_movimiento, cantidad, notas) VALUES (?, 'Entrada', ?, 'Registro inicial')`, [idNuevo, cantidad], (errK) => {
                if (errK) return res.status(500).send('Error en Kardex');
                res.json({ mensaje: 'Producto registrado.', id: idNuevo });
            });
        });
    });
});

// Importación masiva de productos desde Excel (Transaccional)
app.post('/productos/masivo', verificarToken, async (req, res) => {
    const productosMasivos = req.body; 
    const db = conexion.promise();

    try {
        await db.query('START TRANSACTION');

        for (let prod of productosMasivos) {
            const [resP] = await db.query(
                `INSERT INTO Productos (sku, nombre, descripcion, id_categoria, tipo_unidad, stock_minimo) VALUES (?, ?, ?, ?, ?, ?)`,
                [prod.sku, prod.nombre, '-', 1, prod.tipo_unidad || 'Unidad', 5]
            );
            const idNuevo = resP.insertId;

            await db.query(
                `INSERT INTO Inventario_Actual (id_producto, cantidad_disponible, precio_compra, precio_venta) VALUES (?, ?, ?, ?)`,
                [idNuevo, prod.cantidad || 0, prod.precio_compra || 0, prod.precio_venta || 0]
            );

            await db.query(
                `INSERT INTO Kardex_Movimientos (id_producto, tipo_movimiento, cantidad, notas) VALUES (?, 'Entrada', ?, 'Carga masiva desde Excel')`,
                [idNuevo, prod.cantidad || 0]
            );
        }

        await db.query('COMMIT');
        res.json({ mensaje: `¡Se importaron ${productosMasivos.length} productos correctamente!` });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error en carga masiva:', error.message);
        
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ mensaje: 'Error: Detectamos un SKU en el Excel que ya existe en tu base de datos actual.' });
        }
        res.status(500).json({ mensaje: error.message || 'Error interno al procesar el archivo masivo' });
    }
});

app.post('/entradas', verificarToken, (req, res) => {
    const { id_producto, cantidad_agregada, notas } = req.body;
    conexion.query(`UPDATE Inventario_Actual SET cantidad_disponible = cantidad_disponible + ? WHERE id_producto = ?`, [cantidad_agregada, id_producto], (errorActualizar) => {
        if (errorActualizar) return res.status(500).send('Error al sumar el inventario');
        conexion.query(`INSERT INTO Kardex_Movimientos (id_producto, tipo_movimiento, cantidad, notas) VALUES (?, 'Entrada', ?, ?)`, [id_producto, cantidad_agregada, notas], (errorKardex) => {
            if (errorKardex) return res.status(500).send('Error en el historial');
            res.json({ mensaje: '¡Stock agregado con éxito!' });
        });
    });
});

app.put('/productos/:id', verificarToken, (req, res) => {
    const idProducto = req.params.id;
    const { nombre, tipo_unidad, cantidad_disponible, precio_compra, precio_venta } = req.body; 

    conexion.query(`UPDATE Productos SET nombre = ?, tipo_unidad = ? WHERE id_producto = ?`, [nombre, tipo_unidad, idProducto], (errorTextos) => {
        if (errorTextos) return res.status(500).send('Error al actualizar el nombre del producto');
        conexion.query(`UPDATE Inventario_Actual SET cantidad_disponible = ?, precio_compra = ?, precio_venta = ? WHERE id_producto = ?`, [cantidad_disponible, precio_compra, precio_venta, idProducto], (errorNumeros, resultado) => {
            if (errorNumeros) return res.status(500).send('Error al actualizar stock y precios');
            if (resultado.affectedRows === 0) return res.status(404).send('No encontrado');
            res.json({ mensaje: `Producto editado completamente con éxito` });
        });
    });
});

app.delete('/productos/:id', verificarToken, (req, res) => {
    const idProducto = req.params.id;
    conexion.query(`DELETE FROM Kardex_Movimientos WHERE id_producto = ?`, [idProducto], (err1) => {
        if (err1) return res.status(500).send('Error al limpiar el historial');
        conexion.query(`DELETE FROM Inventario_Actual WHERE id_producto = ?`, [idProducto], (err2) => {
            if (err2) return res.status(500).send('Error al limpiar el inventario');
            conexion.query(`DELETE FROM Productos WHERE id_producto = ?`, [idProducto], (err3, resultado) => {
                if (err3) return res.status(500).send('Error final al eliminar');
                if (resultado.affectedRows === 0) return res.status(404).send('Producto no encontrado');
                res.json({ mensaje: `Producto eliminado definitivamente.` });
            });
        });
    });
});

// ==========================================
// CAPA 6: SISTEMA DE FACTURACIÓN Y VENTAS
// ==========================================

// Crear Factura (Transaccional)
app.post('/ventas', verificarToken, async (req, res) => {
    const { cliente, carrito, total } = req.body;
    const db = conexion.promise();

    try {
        await db.query('START TRANSACTION');

        const [resultadoFactura] = await db.query(`INSERT INTO Facturas (cliente, total) VALUES (?, ?)`, [cliente || 'Cliente Mostrador', total]);
        const idFactura = resultadoFactura.insertId;

        for (let item of carrito) {
            const [rowsStock] = await db.query(`SELECT cantidad_disponible FROM Inventario_Actual WHERE id_producto = ?`, [item.id]);
            if (rowsStock.length === 0 || rowsStock[0].cantidad_disponible < item.cantidad) {
                throw new Error(`Stock insuficiente para el producto ID ${item.id}`); 
            }
            await db.query(`INSERT INTO Detalle_Facturas (id_factura, id_producto, cantidad, precio_unitario, subtotal) VALUES (?, ?, ?, ?, ?)`, [idFactura, item.id, item.cantidad, item.precio, item.subtotal]);
            await db.query(`UPDATE Inventario_Actual SET cantidad_disponible = cantidad_disponible - ? WHERE id_producto = ?`, [item.cantidad, item.id]);
            await db.query(`INSERT INTO Kardex_Movimientos (id_producto, tipo_movimiento, cantidad, notas) VALUES (?, 'Salida', ?, ?)`, [item.id, -item.cantidad, `Venta - Factura #${idFactura}`]);
        }

        await db.query('COMMIT');
        res.json({ mensaje: '¡Factura registrada con éxito!', id_factura: idFactura });
    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error procesando la factura:', error.message);
        res.status(500).json({ mensaje: error.message || 'Error interno al procesar la factura' });
    }
});

// Leer Historial de Facturas
app.get('/facturas', verificarToken, (req, res) => {
    const query = `SELECT * FROM Facturas ORDER BY fecha_emision DESC`;
    conexion.query(query, (error, resultados) => {
        if (error) return res.status(500).send('Error al obtener el historial de ventas');
        res.json(resultados);
    });
});

// Ruta para exportar TODO (Facturas + Detalles) a Excel
app.get('/facturas/exportar', verificarToken, (req, res) => {
    const query = `
        SELECT 
            f.id_factura AS 'Folio Factura',
            f.fecha_emision AS 'Fecha de Emisión',
            f.cliente AS 'Cliente',
            f.estado AS 'Estado de Factura',
            p.sku AS 'SKU Producto',
            p.nombre AS 'Producto',
            df.cantidad AS 'Cantidad Comprada',
            p.tipo_unidad AS 'Unidad',
            df.precio_unitario AS 'Precio Unitario (C$)',
            df.subtotal AS 'Subtotal (C$)',
            f.total AS 'Total Factura (C$)'
        FROM Facturas f
        JOIN Detalle_Facturas df ON f.id_factura = df.id_factura
        JOIN Productos p ON df.id_producto = p.id_producto
        ORDER BY f.fecha_emision DESC, f.id_factura DESC
    `;
    conexion.query(query, (error, resultados) => {
        if (error) return res.status(500).send('Error al generar datos para Excel');
        res.json(resultados);
    });
});

// Leer Detalles de una Factura Específica
app.get('/facturas/:id/detalles', verificarToken, (req, res) => {
    const idFactura = req.params.id;
    // Hacemos un JOIN para cruzar el Detalle_Facturas con Productos y sacar el nombre y unidad
    const query = `
        SELECT df.cantidad, df.precio_unitario, df.subtotal, p.nombre, p.tipo_unidad 
        FROM Detalle_Facturas df 
        JOIN Productos p ON df.id_producto = p.id_producto 
        WHERE df.id_factura = ?
    `;
    conexion.query(query, [idFactura], (error, resultados) => {
        if (error) return res.status(500).send('Error al cargar los detalles de la factura');
        res.json(resultados);
    });
});

// Anular Factura y Devolver Stock
app.put('/facturas/:id/anular', verificarToken, async (req, res) => {
    const idFactura = req.params.id;
    const db = conexion.promise();

    try {
        await db.query('START TRANSACTION');

        const [factura] = await db.query(`SELECT estado FROM Facturas WHERE id_factura = ?`, [idFactura]);
        if (factura.length === 0) throw new Error('Factura no encontrada');
        if (factura[0].estado === 'Anulada') throw new Error('La factura ya se encuentra anulada');

        await db.query(`UPDATE Facturas SET estado = 'Anulada' WHERE id_factura = ?`, [idFactura]);

        const [detalles] = await db.query(`SELECT id_producto, cantidad FROM Detalle_Facturas WHERE id_factura = ?`, [idFactura]);

        for (let item of detalles) {
            await db.query(`UPDATE Inventario_Actual SET cantidad_disponible = cantidad_disponible + ? WHERE id_producto = ?`, [item.cantidad, item.id_producto]);
            await db.query(`INSERT INTO Kardex_Movimientos (id_producto, tipo_movimiento, cantidad, notas) VALUES (?, 'Entrada', ?, ?)`, [item.id_producto, item.cantidad, `Devolución - Anulación de Factura #${idFactura}`]);
        }

        await db.query('COMMIT');
        res.json({ mensaje: `Factura #${idFactura} anulada exitosamente. Stock devuelto a bodega.` });

    } catch (error) {
        await db.query('ROLLBACK');
        console.error('Error al anular factura:', error.message);
        res.status(500).json({ mensaje: error.message || 'Error interno al anular la factura' });
    }
});

// ==========================================
// CAPA 7: ESTADÍSTICAS FINANCIERAS
// ==========================================
app.get('/estadisticas', verificarToken, (req, res) => {
    const queryEstadisticas = `
        SELECT 
            COUNT(id_producto) AS tipos_de_productos_diferentes,
            SUM(cantidad_disponible) AS total_articulos_fisicos,
            SUM(cantidad_disponible * precio_compra) AS capital_invertido,
            SUM(cantidad_disponible * precio_venta) AS ganancia_potencial
        FROM Inventario_Actual
    `;
    conexion.query(queryEstadisticas, (error, resultados) => {
        if (error) return res.status(500).send('Error interno al generar el reporte');
        res.json(resultados[0]);
    });
});

// ==========================================
// CAPA 8: ENCENDIDO DEL SERVIDOR
// ==========================================
app.listen(puerto, () => {
    console.log(`🚀 Servidor de nube corriendo en el puerto ${puerto}`);
});