# -*- coding: utf-8 -*-
import io

p = 'phase0/patch-phase9.py'
s = io.open(p, encoding='utf-8', newline='').read()
s = s.replace('\r\n', '\n')
NL = chr(10)
BS = chr(92)

bad1 = '_crlf = "' + NL + '" in src'
good1 = '_crlf = "' + BS + 'r' + BS + 'n" in src'
bad2 = 'src = src.replace("' + NL + '", "' + NL + '")'
good2 = 'src = src.replace("' + BS + 'r' + BS + 'n", "' + BS + 'n")'
bad3 = 'if _crlf: src = src.replace("' + NL + '", "' + NL + '")'
good3 = 'if _crlf: src = src.replace("' + BS + 'n", "' + BS + 'r' + BS + 'n")'

for b, g, tag in ((bad1, good1, '1'), (bad2, good2, '2'), (bad3, good3, '3')):
    assert b in s, tag
    s = s.replace(b, g, 1)

io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('script fixed')
