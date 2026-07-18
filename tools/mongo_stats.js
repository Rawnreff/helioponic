db = db.getSiblingDB('helioponic');

var pipeline = [
  {$group: {
    _id: '$device_id',
    count: {$sum: 1},
    first: {$min: '$recorded_at'},
    last: {$max: '$recorded_at'}
  }}
];

print('Per-device stats:');
db.sensor_logs.aggregate(pipeline).forEach(function(d) {
  print('  ' + d._id + ': ' + d.count + ' records, ' +
    d.first.toISOString().substring(0,10) + ' to ' +
    d.last.toISOString().substring(0,10));
});

// Check July 1-17 specifically
print('\nJuly 1-17 breakdown per device:');
var devices = db.sensor_logs.distinct('device_id');
devices.forEach(function(did) {
  var cnt = db.sensor_logs.countDocuments({
    device_id: did,
    recorded_at: {$gte: new Date('2026-07-01T00:00:00Z'), $lte: new Date('2026-07-17T23:59:59Z')}
  });
  print('  ' + did + ': ' + cnt + ' records in Jul 1-17');
});

// Check total DB size
print('\nCollection stats:');
print('  sensor_logs: ' + db.sensor_logs.countDocuments({}) + ' total documents');
print('  water_records: ' + db.water_records.countDocuments({}) + ' total documents');
print('  energy_records: ' + db.energy_records.countDocuments({}) + ' total documents');
