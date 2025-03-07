/**
 * Node.js 用サンプルコード
 * 
 * 1) GeoJSON の全フィーチャから BBox（西端, 南端, 東端, 北端）を計算
 * 2) minzoom～maxzoom を指定
 * 3) そのズームレベルにおいて、BBox と交差するタイル (x, y) だけをループ
 * 4) タイルごとに PBF 生成 → `./output/z/x/y.pbf` へ保存
 * 
 * （例示のため、点データのみ想定）
 */

const fs = require('fs');
const path = require('path');

// ---------------------- Protobuf / MVT 最低限のエンコード ---------------------- //
function writeVarint(arr, val) {
  // varint をバイト配列 (arr) に追記する
  while (val > 0x7F) {
    arr.push((val & 0x7F) | 0x80);
    val >>= 7;
  }
  arr.push(val);
}

function writeString(arr, fieldNumber, str) {
  // fieldNumber << 3 + wireType(2) => length-delimited
  writeVarint(arr, (fieldNumber << 3) | 2);
  const utf8 = Buffer.from(str, 'utf8');
  writeVarint(arr, utf8.length);
  for (const byte of utf8) {
    arr.push(byte);
  }
}

// ZigZag エンコード (座標のデルタ圧縮用)
function zigZagEncode(num) {
  // 32bit 整数の想定
  return (num << 1) ^ (num >> 31);
}

// 単一 Point 用の簡易ジオメトリ生成 (MoveTo コマンドのみ)
function createPointGeometryCommand(x, y) {
  // MoveTo コマンド (id=1) + 頂点数(1) をひとつの varint にパック
  // コマンドIDは下位3bit, 頂点数は上位ビット
  const commandMoveTo = (1 & 0x7) | (1 << 3); 
  // x, y を ZigZag + varint 化
  const dx = zigZagEncode(x);
  const dy = zigZagEncode(y);
  return [commandMoveTo, dx, dy];
}

/**
 * Feature(点) をエンコード → Feature メッセージのバイナリ配列を返す (Layerに内包)
 */
function encodeFeature(feature) {
  // （本コードでは座標は既にタイル座標(0～4096)に変換済みとしている）
  const [x, y] = feature.geometry.coordinates;
  
  // geometry
  const geomCmds = createPointGeometryCommand(x, y);
  
  // POINT = 1
  const geomTypePoint = 1; 
  
  // 今回は属性(tag)なし、id も省略
  const bytes = [];
  
  // field 3: type = POINT
  writeVarint(bytes, (3 << 3) | 0); // wireType=0 (varint)
  writeVarint(bytes, geomTypePoint);
  
  // field 4: geometry (packed repeated uint32)
  writeVarint(bytes, (4 << 3) | 2); // wireType=2 (length-delimited)
  
  // geometry配列を連続で書くため、先に長さを varint で書く
  const geomBuffer = [];
  for (const val of geomCmds) {
    writeVarint(geomBuffer, val);
  }
  writeVarint(bytes, geomBuffer.length); // packed array のバイト長
  for (const b of geomBuffer) {
    bytes.push(b);
  }
  
  // Feature メッセージを "features" 用 (field=2) の length-delimited で包む
  const featureWrapper = [];
  writeVarint(featureWrapper, (2 << 3) | 2); // features=2, wireType=2
  writeVarint(featureWrapper, bytes.length);
  featureWrapper.push(...bytes);
  
  return featureWrapper;
}

/**
 * Layer をエンコード → Tile.layers=3 用のバイナリ配列
 */
function encodeLayer(features, layerName, extent = 4096) {
  const layerBytes = [];
  
  // field 1: name
  writeString(layerBytes, 1, layerName);
  
  // field 5: extent
  writeVarint(layerBytes, (5 << 3) | 0); // wireType=0
  writeVarint(layerBytes, extent);
  
  // repeated Feature
  for (const f of features) {
    const fBytes = encodeFeature(f);
    layerBytes.push(...fBytes);
  }
  
  // Layer 全体を "layers=3" の length-delimited で包む
  const layerWrapper = [];
  writeVarint(layerWrapper, (3 << 3) | 2); // layers=3, wireType=2
  writeVarint(layerWrapper, layerBytes.length);
  layerWrapper.push(...layerBytes);
  
  return layerWrapper;
}

/**
 * タイル (z, x, y) の座標系に合うように、GeoJSON データをクリップ＆座標変換して PBF を生成する
 * （簡易版: 点のみ対応 & クリップは bbox チェックのみ）
 */
function generateTilePbf(geojson, z, x, y) {
  // タイルの緯度経度 bbox を算出
  const [w, s, e, n] = tileBbox(z, x, y);
  
  // タイルのメルカトル座標 bbox
  const bboxMerc = tileBboxMeters(z, x, y);
  
  // ここでフィーチャをクリップ(点のみ)
  const filteredFeatures = [];
  for (const feat of geojson.features) {
    const [lon, lat] = feat.geometry.coordinates;
    if (lon >= w && lon <= e && lat >= s && lat <= n) {
      // タイル座標(0～4096)に変換
      const [xt, yt] = projectToTileCoordinates(lon, lat, 4096, bboxMerc);
      
      // 新しい Feature を生成
      const newFeature = {
        type: 'Feature',
        properties: feat.properties || {},
        geometry: {
          type: 'Point',
          coordinates: [xt, yt]
        }
      };
      filteredFeatures.push(newFeature);
    }
  }
  
  // フィーチャが何もない場合は空のタイルに (PBF内 layer は0かもしれない)
  if (filteredFeatures.length === 0) {
    // 空のタイルを返す or null を返すなど設計次第
    // ここでは「Layer なし」の空バイナリを返す
    return Buffer.from([]);
  }
  
  // Layer を作成
  const layerBytes = encodeLayer(filteredFeatures, 'myLayer', 4096);
  
  // 複数 Layer を含める場合はさらに連結するが、ここでは1つだけ
  const tileBytes = layerBytes;
  
  return Buffer.from(tileBytes);
}

// ------------------- タイル座標と経度緯度の相互変換 ------------------- //

function tile2lon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}
function tile2lat(y, z) {
  const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
/**
 * タイル (z, x, y) から経度緯度 bbox [west, south, east, north] を返す
 */
function tileBbox(z, x, y) {
  const west = tile2lon(x, z);
  const east = tile2lon(x + 1, z);
  const south = tile2lat(y + 1, z);
  const north = tile2lat(y, z);
  return [west, south, east, north];
}

// 経度緯度→Webメルカトル投影
function lonLatToMeters(lon, lat) {
  const x = lon * 20037508.34 / 180;
  let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = y * 20037508.34 / 180;
  return [x, y];
}

// タイル (z,x,y) に対応するメルカトル座標 bbox [minX, minY, maxX, maxY]
function tileBboxMeters(z, x, y) {
  const [lonMin, latMin, lonMax, latMax] = tileBbox(z, x, y);
  const [minX, minY] = lonLatToMeters(lonMin, latMin);
  const [maxX, maxY] = lonLatToMeters(lonMax, latMax);
  return [minX, minY, maxX, maxY];
}

/**
 * MVT のタイル座標系 (0～extent=4096) に投影する
 */
function projectToTileCoordinates(lon, lat, extent, bboxMerc) {
  const [minX, minY, maxX, maxY] = bboxMerc;
  const [mx, my] = lonLatToMeters(lon, lat);
  const width = maxX - minX;
  const height = maxY - minY;
  
  const xRel = (mx - minX) / width;       // 0..1
  const yRel = (maxY - my) / height;      // 0..1 (北が 0, 南が 1)
  
  const xTile = xRel * extent;
  const yTile = yRel * extent;
  return [Math.floor(xTile), Math.floor(yTile)];
}

// ------------------------- BBox を求める ----------------------------- //

/**
 * GeoJSON (FeatureCollection) から全フィーチャの BBox (west, south, east, north) を計算
 * 例: 点データの場合のみ対応。ライン/ポリゴンの場合は座標全頂点を考慮して実装してください。
 */
function getGeoJsonBBox(geojson) {
  let west = 180, south = 90, east = -180, north = -90;
  
  for (const feat of geojson.features) {
    const [lon, lat] = feat.geometry.coordinates;
    if (lon < west)  west = lon;
    if (lon > east)  east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  
  return [west, south, east, north];
}

// 経度→タイルX
function long2tileX(lon, zoom) {
  return Math.floor((lon + 180) / 360 * Math.pow(2, zoom));
}
// 緯度→タイルY
function lat2tileY(lat, zoom) {
  const rad = lat * Math.PI / 180;
  return Math.floor(
    (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, zoom)
  );
}

/**
 * min、max、そしてズームレベルに応じて、
 * 「BBox と重なるタイル x,y の最小～最大」を算出するヘルパー
 */
function getTileRangeFromBBox(bbox, z) {
  const [west, south, east, north] = bbox;
  
  // x の範囲
  let xMin = long2tileX(west, z);
  let xMax = long2tileX(east, z);
  
  // y の範囲 (注意：北から南へと y が増える)
  let yMin = lat2tileY(north, z);
  let yMax = lat2tileY(south, z);
  
  // タイル全体の有効範囲は [0, 2^z - 1]
  const maxIndex = (1 << z) - 1;
  xMin = Math.max(0, Math.min(xMin, maxIndex));
  xMax = Math.max(0, Math.min(xMax, maxIndex));
  yMin = Math.max(0, Math.min(yMin, maxIndex));
  yMax = Math.max(0, Math.min(yMax, maxIndex));
  
  // xMin > xMax, yMin > yMax の場合は該当なし
  return [xMin, xMax, yMin, yMax];
}

// ----------------------- メイン処理例 ------------------------- //

// 1) GeoJSON を読み込み
const inputPath = 'map.geojson';
const geojson = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

// 2) 全フィーチャの BBox を取得 (点データのみ想定)
const [west, south, east, north] = getGeoJsonBBox(geojson);

// 3) minzoom & maxzoom
const minzoom = 9;
const maxzoom = 18; // 例として z=5～7

// 4) ズームごとに、BBox と交差するタイルだけを生成して出力
for (let z = minzoom; z <= maxzoom; z++) {
  const [xMin, xMax, yMin, yMax] = getTileRangeFromBBox([west, south, east, north], z);
  
  for (let x = xMin; x <= xMax; x++) {
    // 出力先ディレクトリを用意
    const zxDir = path.join('output_tiles', String(z), String(x));
    fs.mkdirSync(zxDir, { recursive: true });
    
    for (let y = yMin; y <= yMax; y++) {
      // タイル1枚ぶんのPBF生成
      const pbfBuffer = generateTilePbf(geojson, z, x, y);
      
      // もし「空タイルはスキップしたい」場合はバッファサイズやフィーチャ数などをチェックして判定
      if (pbfBuffer.length === 0) {
        // スキップするなら continue;
        // 今回はファイルを出力しないでスキップ
        continue;
      }
      
      // ファイル書き込み
      const tilePath = path.join(zxDir, `${y}.pbf`);
      fs.writeFileSync(tilePath, pbfBuffer);
    }
  }
}

console.log('タイル生成が完了しました！');
