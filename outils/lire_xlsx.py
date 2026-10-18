"""Lecture d'un .xlsx avec la bibliothèque standard (lecture seule). Copie de 04_Robots_Action/outils/xlsx_lire.py."""
import zipfile, re, xml.etree.ElementTree as ET
NS={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
def _col(ref):
    s=re.match(r'[A-Z]+',ref).group(); n=0
    for ch in s: n=n*26+ord(ch)-64
    return n-1
def feuilles(chemin):
    z=zipfile.ZipFile(chemin)
    ss=[]
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si',NS):
            ss.append(''.join(t.text or '' for t in si.iter('{%s}t'%NS['m'])))
    wb=ET.fromstring(z.read('xl/workbook.xml'))
    rels=ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
    cible={r.get('Id'):r.get('Target') for r in rels}
    out={}
    for s in wb.find('m:sheets',NS):
        t=cible[s.get('{%s}id'%NS['r'])].lstrip('/')
        if not t.startswith('xl/'): t='xl/'+t
        out[s.get('name')]=(z,t,ss)
    return out
def lignes(z,t,ss):
    for row in ET.fromstring(z.read(t)).iter('{%s}row'%NS['m']):
        vals={}
        for c in row.findall('m:c',NS):
            v=c.find('m:v',NS); typ=c.get('t')
            if typ=='s' and v is not None: x=ss[int(v.text)]
            elif typ=='inlineStr': x=''.join(e.text or '' for e in c.iter('{%s}t'%NS['m']))
            else: x=v.text if v is not None else None
            vals[_col(c.get('r'))]=x
        if vals: yield [vals.get(i) for i in range(max(vals)+1)]
        else: yield []
