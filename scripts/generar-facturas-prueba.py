"""Genera PDFs de prueba con el formato de las facturas electrónicas de AFIP/ARCA.
Uso: python3 scripts/generar-facturas-prueba.py  (requiere reportlab)
Los PDFs quedan en scripts/facturas-prueba/ y los usa scripts/test-factura-pdf.ts."""
import os
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

DIR = os.path.join(os.path.dirname(__file__), 'facturas-prueba')
os.makedirs(DIR, exist_ok=True)
W, H = A4

EMISOR = dict(nombre='DE&CO S.A.', cuit='30714567892', dom='Av. Colón 1234 - Córdoba')


def afip(c, copia, letra, cod, titulo, pv, nro, fecha, rec_cuit, rec_nombre, rec_iva, items, totales, asociado=None, doc='CUIT'):
    c.setFont('Helvetica-Bold', 12); c.drawCentredString(W / 2, H - 40, copia)
    c.rect(30, H - 190, W - 60, 140)
    c.setFont('Helvetica-Bold', 16); c.drawString(45, H - 80, EMISOR['nombre'])
    c.setFont('Helvetica', 9)
    c.drawString(45, H - 110, 'Razón Social: ' + EMISOR['nombre'])
    c.drawString(45, H - 125, 'Domicilio Comercial: ' + EMISOR['dom'])
    c.drawString(45, H - 140, 'Condición frente al IVA: IVA Responsable Inscripto')
    c.rect(W / 2 - 25, H - 105, 50, 50)
    c.setFont('Helvetica-Bold', 30); c.drawCentredString(W / 2, H - 92, letra)
    c.setFont('Helvetica-Bold', 7); c.drawCentredString(W / 2, H - 102, 'COD. %02d' % cod)
    c.setFont('Helvetica-Bold', 16); c.drawString(W / 2 + 40, H - 80, titulo)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(W / 2 + 40, H - 100, 'Punto de Venta: %05d' % pv)
    c.drawString(W / 2 + 150, H - 100, 'Comp. Nro: %08d' % nro)
    c.drawString(W / 2 + 40, H - 115, 'Fecha de Emisión: ' + fecha)
    c.setFont('Helvetica', 9)
    c.drawString(W / 2 + 40, H - 135, 'CUIT: ' + EMISOR['cuit'])
    c.drawString(W / 2 + 40, H - 150, 'Ingresos Brutos: 280123456')
    c.drawString(W / 2 + 40, H - 165, 'Fecha de Inicio de Actividades: 01/03/2015')
    c.drawString(45, H - 210, 'Período Facturado Desde: ' + fecha)
    c.drawString(250, H - 210, 'Hasta: ' + fecha)
    c.drawString(380, H - 210, 'Fecha de Vto. para el pago: 20/11/2026')
    c.rect(30, H - 290, W - 60, 65)
    c.setFont('Helvetica-Bold', 9)
    c.drawString(45, H - 245, doc + ': ' + rec_cuit)
    c.drawString(200, H - 245, 'Apellido y Nombre / Razón Social: ' + rec_nombre)
    c.setFont('Helvetica', 9)
    c.drawString(45, H - 262, 'Condición frente al IVA: ' + rec_iva)
    c.drawString(330, H - 262, 'Domicilio: Ruta 9 Km 5 - Córdoba')
    c.drawString(45, H - 279, 'Condición de venta: Cuenta Corriente')
    if asociado:
        c.drawString(330, H - 279, 'Comprobante asociado: ' + asociado)
    y = H - 315
    c.setFont('Helvetica-Bold', 8)
    for x, t in [(35, 'Código'), (80, 'Producto / Servicio'), (260, 'Cantidad'), (310, 'U. Medida'), (360, 'Precio Unit.'), (420, '% Bonif'), (460, 'Subtotal'), (520, 'Subtotal c/IVA')]:
        c.drawString(x, y, t)
    c.setFont('Helvetica', 8)
    for it in items:
        y -= 15
        for x, t in zip([35, 80, 260, 310, 360, 420, 460, 520], it):
            c.drawString(x, y, t)
    y = 200
    c.setFont('Helvetica-Bold', 9)
    for k, v in totales:
        c.drawRightString(440, y, k + ': $')
        c.drawRightString(560, y, v)
        y -= 15
    c.setFont('Helvetica', 8)
    c.drawString(350, 70, 'CAE N°: 76423456789012')
    c.drawString(350, 58, 'Fecha de Vto. de CAE: 31/10/2026')
    c.drawString(45, 58, 'Pág. 1/1')
    c.drawString(45, 70, 'Comprobante Autorizado')
    c.showPage()


def f1():
    c = canvas.Canvas(os.path.join(DIR, 'factura-a-3-copias.pdf'), pagesize=A4)
    for copia in ['ORIGINAL', 'DUPLICADO', 'TRIPLICADO']:
        afip(c, copia, 'A', 1, 'FACTURA', 3, 1234, '21/10/2026', '30-71234567-1'.replace('-', ''), 'METALURGICA NORTE S.R.L.', 'IVA Responsable Inscripto',
             [['001', 'Rodamiento 6205 2RS', '2,00', 'unidades', '15000,00', '0,00', '30000,00', '36300,00'],
              ['002', 'Correa A-42', '1,00', 'unidades', '1234000,00', '0,00', '1234000,00', '1493140,00']],
             [('Importe Neto Gravado', '1264000,00'), ('IVA 27%', '0,00'), ('IVA 21%', '265440,00'), ('IVA 10.5%', '0,00'), ('Importe Otros Tributos', '0,00'), ('Importe Total', '1529440,00')])
    c.save()


def f2():
    c = canvas.Canvas(os.path.join(DIR, 'nota-credito-a.pdf'), pagesize=A4)
    afip(c, 'ORIGINAL', 'A', 3, 'NOTA DE CRÉDITO', 3, 57, '22/10/2026', '30712345671', 'METALURGICA NORTE S.R.L.', 'IVA Responsable Inscripto',
         [['001', 'Devolución Correa A-42', '1,00', 'unidades', '10000,00', '0,00', '10000,00', '12100,00']],
         [('Importe Neto Gravado', '10000,00'), ('IVA 21%', '2100,00'), ('Importe Otros Tributos', '0,00'), ('Importe Total', '12100,00')],
         asociado='Factura A 00003-00001234')
    c.save()


def f3():
    c = canvas.Canvas(os.path.join(DIR, 'factura-b-consumidor-final.pdf'), pagesize=A4)
    afip(c, 'ORIGINAL', 'B', 6, 'FACTURA', 5, 98765, '21/10/2026', '28123456', 'PEREZ JUAN CARLOS', 'Consumidor Final',
         [['001', 'Juego de bulones', '10,00', 'unidades', '1.250,50', '0,00', '12.505,00', '12.505,00']],
         [('Subtotal', '12.505,00'), ('Importe Otros Tributos', '0,00'), ('Importe Total', '12.505,00')], doc='DNI')
    c.save()


def f4():
    c = canvas.Canvas(os.path.join(DIR, 'fce-mipyme.pdf'), pagesize=A4)
    afip(c, 'ORIGINAL', 'A', 201, 'FACTURA DE CRÉDITO ELECTRÓNICA MiPyMEs (FCE)', 3, 88, '21/10/2026', '30500010912', 'AGRO PAMPA S.A.', 'IVA Responsable Inscripto',
         [['001', 'Motor reductor 1HP', '1,00', 'unidades', '2500000,00', '0,00', '2500000,00', '3025000,00']],
         [('Importe Neto Gravado', '2500000,00'), ('IVA 21%', '525000,00'), ('Importe Total', '3025000,00')])
    c.save()


def f5():
    c = canvas.Canvas(os.path.join(DIR, 'presupuesto.pdf'), pagesize=A4)
    c.setFont('Helvetica-Bold', 16); c.drawString(40, H - 60, 'DE&CO S.A.')
    c.drawString(380, H - 60, 'PRESUPUESTO')
    c.setFont('Helvetica', 9)
    c.drawString(380, H - 80, 'N° 0001-00004567')
    c.drawString(380, H - 95, 'Fecha: 20/10/2026')
    c.drawString(40, H - 120, 'Señor(es): TORNILLERIA EL TORNILLO')
    c.drawString(40, H - 135, 'CUIT: 20-12345678-6')
    c.drawString(40, H - 400, 'Subtotal: 40.000,00')
    c.drawString(40, H - 415, 'TOTAL $ 48.400,00')
    c.drawString(40, 60, 'Documento no válido como factura')
    c.showPage(); c.save()


def f6():
    # Formato "de sistema" (no AFIP): etiquetas Cliente:, Subtotal y TOTAL en el mismo renglón
    c = canvas.Canvas(os.path.join(DIR, 'factura-sistema.pdf'), pagesize=A4)
    c.setFont('Helvetica-Bold', 14); c.drawString(40, H - 60, 'DE&CO S.A.   CUIT 30-71456789-2')
    c.drawString(400, H - 60, 'FACTURA  A')
    c.setFont('Helvetica', 9)
    c.drawString(400, H - 80, 'Nro: 0004-00000321')
    c.drawString(400, H - 95, 'Fecha: 19/10/2026')
    c.drawString(40, H - 120, 'Cliente: FERRETERIA LOS ANDES SRL')
    c.drawString(330, H - 120, 'C.U.I.T.: 30-50001091-2')
    c.drawString(40, H - 135, 'Domicilio: San Martín 55 - Jesús María')
    c.drawString(40, H - 500, 'Subtotal: 10.203,03')
    c.drawString(250, H - 500, 'IVA 21%: 2.142,64')
    c.drawString(420, H - 500, 'TOTAL: 12.345,67')
    c.drawString(40, 60, 'CAE: 76423456789012')
    c.showPage(); c.save()


def f7():
    # "Escaneo": solo una imagen, sin texto
    from reportlab.lib.utils import ImageReader
    import io, zlib, struct
    def png(w, h):
        raw = b''.join(b'\x00' + b'\xff' * (w * 3) for _ in range(h))
        def chunk(t, d):
            return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    c = canvas.Canvas(os.path.join(DIR, 'escaneada.pdf'), pagesize=A4)
    c.drawImage(ImageReader(io.BytesIO(png(20, 20))), 50, 50, 400, 600)
    c.showPage(); c.save()


for f in [f1, f2, f3, f4, f5, f6, f7]:
    f()
print('ok', sorted(os.listdir(DIR)))
