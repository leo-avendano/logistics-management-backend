/*
 * Import function triggers from their respective submodules:
 *
 * import {onCall} from "firebase-functions/v2/https";
 * import {onDocumentWritten} from "firebase-functions/v2/firestore";
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */


import {onRequest} from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';
import * as admin from 'firebase-admin';
// import {v4 as uuidv4} from 'uuid';
import {Request, Response} from 'express';

admin.initializeApp();
const db = admin.firestore();

// Define proper types for the request and response
interface AuthenticatedRequest extends Request {
  user: admin.auth.DecodedIdToken;
}

const authenticateRequest = async (
  req: Request,
  res: Response,
  next: () => void
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({error: 'Unauthorized - No token provided'});
    return;
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    (req as AuthenticatedRequest).user = decodedToken;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.status(401).json({error: 'Unauthorized - Invalid token'});
  }
};

export const helloWorld = onRequest((req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  logger.info('Hello logs!', {structuredData: true});
  res.json({
    message: 'Hello from Firebase!',
    timestamp: new Date().toISOString(),
  });
});

const generateConfirmationCode = (): string => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return code;
};

export const addPackageAndRoute = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const packageData = req.body;
      const packageUUID = 'asdf'; // uuidv4();
      const confirmationCode = generateConfirmationCode();

      const batch = db.batch();

      const packageRef = db.collection('Paquete').doc(packageUUID);
      batch.set(packageRef, {
        ...packageData,
        uuid: packageUUID,
        estado: 'disponible',
        createdBy: (req as unknown as AuthenticatedRequest).user.uid,
      });

      const routeRef = db.collection('Ruta').doc();
      batch.set(routeRef, {
        paqueteRef: packageUUID,
        destino: packageData.destino,
        fechas: packageData.fechas,
        repartidorUserID: null,
      });

      const confirmationRef = db.collection('CodigoConfirmacion').doc();
      batch.set(confirmationRef, {
        paqueteRef: packageUUID,
        codigo: confirmationCode,
      });

      await batch.commit();
      res.status(201).json({success: true, packageUUID, confirmationCode});
    });
  } catch (error) {
    res.status(500).json({error: 'Error creating package and route'});
  }
});

export const modifyRouteDestination = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const {packageUUID, newDestination} = req.body;

      const packageDoc = await db.collection('Paquete').doc(packageUUID).get();
      if (!packageDoc.exists) {
        res.status(404).json({error: 'Package not found'});
        return;
      }

      const packageData = packageDoc.data();
      if (!['disponible', 'pendiente'].includes(packageData?.estado)) {
        res.status(400).json({error: 'Package not in modifiable state'});
        return;
      }

      const routeQuery = await db.collection('Ruta')
        .where('paqueteRef', '==', packageUUID)
        .limit(1)
        .get();

      if (routeQuery.empty) {
        res.status(404).json({error: 'Route not found'});
        return;
      }

      await routeQuery.docs[0].ref.update({destino: newDestination});
      res.status(200).json({success: true});
    });
  } catch (error) {
    res.status(500).json({error: 'Error modifying destination'});
  }
});

export const assignRouteToRepartidor = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    logger.error('Method not allowed');
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const {routeUUID} = req.body;
      const authenticatedReq = req as unknown as AuthenticatedRequest;
      const userID = authenticatedReq.user.uid;
      logger.info('Assigning route to repartidor', {routeUUID, userID});
      await db.runTransaction(async (transaction) => {
        const routeRef = db.collection('Ruta').doc(routeUUID);
        logger.info('Getting route', {routeRef});
        const routeDoc = await transaction.get(routeRef);
        logger.info('Route found', {routeDoc});
        if (!routeDoc.exists) {
          logger.error('Route not found');
          throw new Error('Route not found');
        }
        if (routeDoc.data()?.estado !== 'disponible') {
          logger.error('Route not available for assignment');
          throw new Error('Route not available for assignment');
        }

        transaction.update(routeRef, {estado: 'pendiente', repartidorUserID: userID});
        logger.info('Route updated', {routeRef});
      });

      res.status(200).json({success: true});
    });
  } catch (error) {
    logger.error('Error assigning route', {error});
    res.status(400).json({error: (error as Error).message});
  }
});

export const confirmPackageDelivery = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const {packageUUID, codigo} = req.body;

      await db.runTransaction(async (transaction) => {
        const packageRef = db.collection('Paquete').doc(packageUUID);
        const packageDoc = await transaction.get(packageRef);

        if (!packageDoc.exists) throw new Error('Package not found');
        if (packageDoc.data()?.estado !== 'en curso') {
          throw new Error('Package not in deliverable state');
        }

        const confirmationQuery = await db.collection('CodigoConfirmacion')
          .where('paqueteRef', '==', packageUUID)
          .limit(1)
          .get();

        if (confirmationQuery.empty) throw new Error('Confirmation code not found');
        if (confirmationQuery.docs[0].data().codigo !== codigo) {
          throw new Error('Invalid confirmation code');
        }

        transaction.update(packageRef, {estado: 'completado'});
      });

      res.status(200).json({success: true});
    });
  } catch (error) {
    res.status(400).json({error: (error as Error).message});
  }
});

export const startPendingRoute = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const {packageUUID} = req.body;

      const packageRef = db.collection('Paquete').doc(packageUUID);
      const packageDoc = await packageRef.get();

      if (!packageDoc.exists) {
        res.status(404).json({error: 'Package not found'});
        return;
      }

      if (packageDoc.data()?.estado !== 'pendiente') {
        res.status(400).json({error: 'Package not in pending state'});
        return;
      }

      await packageRef.update({estado: 'en curso'});
      res.status(200).json({success: true});
    });
  } catch (error) {
    res.status(500).json({error: 'Error starting route'});
  }
});

export const unassignRouteFromRepartidor = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({error: 'Method not allowed'});
    return;
  }
  try {
    await authenticateRequest(req, res, async () => {
      const authenticatedReq = req as unknown as AuthenticatedRequest;
      const userID = authenticatedReq.user.uid;
      const {routeUUID} = req.body;

      if (!routeUUID) {
        res.status(400).json({error: 'Route UUID is required'});
        return;
      }

      const routeRef = db.collection('Ruta').doc(routeUUID);
      const routeDoc = await routeRef.get();

      if (!routeDoc.exists) {
        res.status(404).json({error: 'Route not found'});
        return;
      }

      const routeData = routeDoc.data();
      if (routeData?.estado !== 'pendiente' || routeData?.repartidorUserID !== userID) {
        res.status(400).json({error: 'Route is not assigned to this repartidor or is not in pending state'});
        return;
      }

      try {
        await db.runTransaction(async (transaction) => {
          transaction.update(routeRef, {
            estado: 'disponible',
            repartidorUserID: '',
          });
        });

        res.status(200).json({message: 'Route unassigned successfully'});
      } catch (error) {
        console.error('Error unassigning route:', error);
        res.status(500).json({error: 'Failed to unassign route'});
      }
    });
  } catch (error) {
    console.error('Error in unassignRouteFromRepartidor:', error);
    res.status(401).json({error: 'Authentication failed'});
  }
});
