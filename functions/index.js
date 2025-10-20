const {onCall} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {S3Client, PutObjectCommand} = require("@aws-sdk/client-s3");
const {getSignedUrl} = require("@aws-sdk/s3-request-presigner");
const { SESClient, SendEmailCommand, SendRawEmailCommand } = require('@aws-sdk/client-ses');
// Use a simpler approach for PDF generation

// Initialize Firebase Admin SDK
admin.initializeApp();

// Initialize S3 Client
const s3Client = new S3Client({
  region: process.env.AWS_REGION || "ap-southeast-2",
  credentials: {
    accessKeyId: "AKIA4ZPZU223S7RIND6Q",
    secretAccessKey: "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"
  }
});

// Initialize AWS SES Client
const sesClient = new SESClient({
  region: process.env.AWS_SES_REGION || 'ap-southeast-2',
  credentials: {
    accessKeyId: process.env.AWS_SES_ROLE_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SES_ROLE_ACCESS_KEY,
  },
});

const fromEmail = process.env.AWS_SES_FROM_ADDRESS || 'qq1097215944@gmail.com';

logger.info('AWS SES initialized successfully', { 
  hasCredentials: !!(process.env.AWS_SES_ROLE_ACCESS_KEY_ID && process.env.AWS_SES_ROLE_ACCESS_KEY),
  fromEmail: fromEmail,
  region: process.env.AWS_SES_REGION || 'ap-southeast-2'
});

// For cost control, you can set the maximum number of containers that can be
// running at the same time. This helps mitigate the impact of unexpected
// traffic spikes by instead downgrading performance. This limit is a
// per-function limit. You can override the limit for each function using the
// `runWith` option.
const MAX_CONCURRENT = 3;

// Create a program
exports.createProgram = onCall(async (request) => {
  try {
    const programData = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to create a program");
    }

    // Add organizer information
    programData.organizer_id = userId;
    programData.created_at = admin.firestore.FieldValue.serverTimestamp();
    programData.status = "active";

    // Create program in Firestore
    const docRef = await admin.firestore().collection('programs').add(programData);

    logger.info("Program created successfully", { 
      programId: docRef.id, 
      organizerId: userId 
    });

    return {
      success: true,
      programId: docRef.id,
      message: "Program created successfully"
    };

  } catch (error) {
    logger.error("Error creating program", { 
      error: error.message,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to create program: ${error.message}`);
  }
});

// Update a program
exports.updateProgram = onCall(async (request) => {
  try {
    const { programId, programData } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to update a program");
    }

    if (!programId) {
      throw new Error("Program ID is required");
    }

    // Check if user is the organizer of this program
    const programDoc = await admin.firestore().collection('programs').doc(programId).get();
    
    if (!programDoc.exists) {
      throw new Error("Program not found");
    }

    const program = programDoc.data();
    if (program.organizer_id !== userId) {
      throw new Error("Only the organizer can update this program");
    }

    // Update program data
    programData.updated_at = admin.firestore.FieldValue.serverTimestamp();

    await admin.firestore().collection('programs').doc(programId).update(programData);

    logger.info("Program updated successfully", { 
      programId, 
      organizerId: userId 
    });

    return {
      success: true,
      programId: programId,
      message: "Program updated successfully"
    };

  } catch (error) {
    logger.error("Error updating program", { 
      error: error.message,
      programId: request.data?.programId,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to update program: ${error.message}`);
  }
});

// Cancel a program
exports.cancelProgram = onCall(async (request) => {
  try {
    const { programId } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to cancel a program");
    }

    if (!programId) {
      throw new Error("Program ID is required");
    }

    // Get program details
    const programDoc = await admin.firestore().collection('programs').doc(programId).get();
    
    if (!programDoc.exists) {
      throw new Error("Program not found");
    }

    const program = programDoc.data();
    
    // Get the current user's email to verify ownership
    const userDoc = await admin.firestore().collection('user-information').doc(userId).get();
    if (!userDoc.exists) {
      throw new Error("User not found");
    }
    const userData = userDoc.data();
    const userEmail = userData.email;
    
    if (program.organizer_email !== userEmail) {
      throw new Error("Only the organizer can cancel this program");
    }

    if (program.status === 'cancelled') {
      throw new Error("Program is already cancelled");
    }

    // Get all appointments for this program
    const appointmentsSnapshot = await admin.firestore()
      .collection('appointments')
      .where('program_id', '==', programId)
      .where('status', '==', 'confirmed')
      .get();

    // Collect participant emails
    const participantEmails = new Set();
    const appointmentIds = [];

    appointmentsSnapshot.forEach(doc => {
      const appointment = doc.data();
      if (appointment.member_email) {
        participantEmails.add(appointment.member_email);
      }
      appointmentIds.push(doc.id);
    });

    // Update program status to cancelled
    await admin.firestore().collection('programs').doc(programId).update({
      status: 'cancelled',
      cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
      cancelled_by: userId
    });

    // Cancel all appointments and create notifications
    const batch = admin.firestore().batch();
    
    // Cancel appointments
    appointmentIds.forEach(appointmentId => {
      const appointmentRef = admin.firestore().collection('appointments').doc(appointmentId);
      batch.update(appointmentRef, {
        status: 'cancelled',
        cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
        cancelled_by: 'organizer'
      });
    });
    
    // Create notifications for each participant
    for (const email of participantEmails) {
      const notificationRef = admin.firestore().collection('notifications').doc();
      const notificationData = {
        notification_id: notificationRef.id,
        user_email: email,
        notification_title: `Program Cancelled: ${program.title}`,
        notification_text: `The program "${program.title}" has been cancelled by the organizer. Your appointment has been automatically cancelled and removed from your account.`,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        read: false
      };
      batch.set(notificationRef, notificationData);
    }
    
    await batch.commit();

    // Send email notifications to participants
    logger.info('Sending email notifications to participants', { 
      programId, 
      participantCount: participantEmails.size,
      participantEmails: Array.from(participantEmails)
    });

    const emailPromises = [];
    for (const email of participantEmails) {
      logger.info('Queuing email for participant', { email, programId });
      const emailPromise = sendProgramCancellationEmail(email, program, userEmail);
      emailPromises.push(emailPromise);
    }

    // Send emails asynchronously (don't wait for them to complete)
    Promise.allSettled(emailPromises).then(results => {
      const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      const failed = results.filter(r => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.success)).length;
      logger.info('Email sending completed', { successful, failed });
    });

    logger.info("Program cancelled successfully", { 
      programId, 
      organizerId: userId,
      appointmentsCancelled: appointmentIds.length,
      participantsNotified: participantEmails.size
    });

    return {
      success: true,
      programId: programId,
      message: "Program cancelled successfully",
      appointmentsCancelled: appointmentIds.length,
      participantsNotified: participantEmails.size
    };

  } catch (error) {
    logger.error("Error cancelling program", { 
      error: error.message,
      programId: request.data?.programId,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to cancel program: ${error.message}`);
  }
});

// Create an appointment
exports.createAppointment = onCall(async (request) => {
  try {
    // Handle both old and new data structures
    const { programId, program_id, appointmentData, user_email, time_slot } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to create an appointment");
    }

    // Use programId or program_id (for backward compatibility)
    const actualProgramId = programId || program_id;
    if (!actualProgramId) {
      throw new Error("Program ID is required");
    }

    // Check if program exists and is active
    const programDoc = await admin.firestore().collection('programs').doc(actualProgramId).get();
    
    if (!programDoc.exists) {
      throw new Error("Program not found");
    }

    const program = programDoc.data();
    if (program.status !== 'active') {
      throw new Error("Cannot create appointment for inactive program");
    }

    // Check if user already has an appointment for this program
    const existingAppointment = await admin.firestore()
      .collection('appointments')
      .where('program_id', '==', actualProgramId)
      .where('member_id', '==', userId)
      .where('status', '==', 'confirmed')
      .get();

    if (!existingAppointment.empty) {
      throw new Error("You already have a confirmed appointment for this program");
    }

    // Handle time slot data - extract date and time from time_slot array
    let appointmentDate = '';
    let appointmentTime = '';
    
    if (time_slot && time_slot.length > 0) {
      const slot = time_slot[0]; // Use first time slot
      appointmentDate = slot.startDate || '';
      appointmentTime = `${slot.start || ''} - ${slot.end || ''}`;
    } else if (appointmentData) {
      appointmentDate = appointmentData.appointment_date || '';
      appointmentTime = appointmentData.appointment_time || '';
    }

    // Create appointment
    const appointment = {
      program_id: actualProgramId,
      member_id: userId,
      member_email: user_email || request.auth?.token?.email || '',
      member_name: request.auth?.token?.name || '',
      appointment_date: appointmentDate,
      appointment_time: appointmentTime,
      time_slot: time_slot || appointmentData?.time_slot || null,
      status: 'confirmed',
      created_at: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await admin.firestore().collection('appointments').add(appointment);

    logger.info("Appointment created successfully", { 
      appointmentId: docRef.id, 
      programId: actualProgramId, 
      memberId: userId 
    });

    return {
      success: true,
      appointmentId: docRef.id,
      message: "Appointment created successfully"
    };

  } catch (error) {
    logger.error("Error creating appointment", { 
      error: error.message,
      programId: request.data?.programId || request.data?.program_id,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to create appointment: ${error.message}`);
  }
});

// Update an appointment
exports.updateAppointment = onCall(async (request) => {
  try {
    const { appointmentId, appointmentData } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to update an appointment");
    }

    if (!appointmentId) {
      throw new Error("Appointment ID is required");
    }

    // Check if appointment exists and belongs to user
    const appointmentDoc = await admin.firestore().collection('appointments').doc(appointmentId).get();
    
    if (!appointmentDoc.exists) {
      throw new Error("Appointment not found");
    }

    const appointment = appointmentDoc.data();
    if (appointment.member_id !== userId) {
      throw new Error("You can only update your own appointments");
    }

    // Update appointment data
    appointmentData.updated_at = admin.firestore.FieldValue.serverTimestamp();

    await admin.firestore().collection('appointments').doc(appointmentId).update(appointmentData);

    logger.info("Appointment updated successfully", { 
      appointmentId, 
      memberId: userId 
    });

    return {
      success: true,
      appointmentId: appointmentId,
      message: "Appointment updated successfully"
    };

  } catch (error) {
    logger.error("Error updating appointment", { 
      error: error.message,
      appointmentId: request.data?.appointmentId,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to update appointment: ${error.message}`);
  }
});

// Cancel an appointment
exports.cancelAppointment = onCall(async (request) => {
  try {
    const { appointmentId } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to cancel an appointment");
    }

    if (!appointmentId) {
      throw new Error("Appointment ID is required");
    }

    // Get appointment details
    const appointmentDoc = await admin.firestore().collection('appointments').doc(appointmentId).get();
    
    if (!appointmentDoc.exists) {
      throw new Error("Appointment not found");
    }

    const appointment = appointmentDoc.data();
    if (appointment.member_id !== userId) {
      throw new Error("You can only cancel your own appointments");
    }

    if (appointment.status === 'cancelled') {
      throw new Error("Appointment is already cancelled");
    }

    // Get program details for email notification
    const programDoc = await admin.firestore().collection('programs').doc(appointment.program_id).get();
    const program = programDoc.data();

    // Get organizer details
    const organizerDoc = await admin.firestore().collection('users').doc(program.organizer_id).get();
    const organizer = organizerDoc.data();

    // Update appointment status to cancelled
    await admin.firestore().collection('appointments').doc(appointmentId).update({
      status: 'cancelled',
      cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
      cancelled_by: 'member'
    });

    // Send email notification to organizer
    if (organizer && organizer.email) {
      const memberData = {
        displayName: appointment.member_name || 'Member',
        email: appointment.member_email
      };

      try {
        await sendAppointmentCancellationEmail(organizer.email, appointment, memberData);
        logger.info("Appointment cancellation email sent to organizer", { 
          organizerEmail: organizer.email,
          appointmentId 
        });
      } catch (emailError) {
        logger.error("Failed to send appointment cancellation email", { 
          error: emailError.message,
          organizerEmail: organizer.email,
          appointmentId 
        });
      }
    }

    logger.info("Appointment cancelled successfully", { 
      appointmentId, 
      memberId: userId 
    });

    return {
      success: true,
      appointmentId: appointmentId,
      message: "Appointment cancelled successfully"
    };

  } catch (error) {
    logger.error("Error cancelling appointment", { 
      error: error.message,
      appointmentId: request.data?.appointmentId,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to cancel appointment: ${error.message}`);
  }
});

// Get user appointments
exports.getUserAppointments = onCall(async (request) => {
  try {
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to get appointments");
    }

    // Get all appointments for the user
    const appointmentsSnapshot = await admin.firestore()
      .collection('appointments')
      .where('member_id', '==', userId)
      .get();

    const appointments = [];
    appointmentsSnapshot.forEach(doc => {
      appointments.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Sort appointments by created_at in descending order (newest first)
    appointments.sort((a, b) => {
      const aTime = a.created_at?.toDate?.() || new Date(a.created_at || 0);
      const bTime = b.created_at?.toDate?.() || new Date(b.created_at || 0);
      return bTime - aTime;
    });

    logger.info("User appointments retrieved successfully", { 
      userId, 
      appointmentCount: appointments.length 
    });

    return {
      success: true,
      appointments: appointments
    };

  } catch (error) {
    logger.error("Error getting user appointments", { 
      error: error.message,
      userId: request.auth?.uid
    });
    
    throw new Error(`Failed to get appointments: ${error.message}`);
  }
});

// Get user notifications
exports.getUserNotifications = onCall(async (request) => {
  try {
    const { userEmail } = request.data;

    if (!userEmail) {
      throw new Error("User email is required");
    }

    // Get all notifications for the user
    const notificationsSnapshot = await admin.firestore()
      .collection('notifications')
      .where('user_email', '==', userEmail)
      .get();

    const notifications = [];
    notificationsSnapshot.forEach(doc => {
      notifications.push({
        id: doc.id,
        ...doc.data()
      });
    });

    // Sort notifications by created_at in descending order (newest first)
    notifications.sort((a, b) => {
      const aTime = a.created_at?.toDate?.() || new Date(a.created_at || 0);
      const bTime = b.created_at?.toDate?.() || new Date(b.created_at || 0);
      return bTime - aTime;
    });

    logger.info("User notifications retrieved successfully", { 
      userEmail, 
      notificationCount: notifications.length 
    });

    return {
      success: true,
      notifications: notifications
    };

  } catch (error) {
    logger.error("Error getting user notifications", { 
      error: error.message,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to get notifications: ${error.message}`);
  }
});

// Mark notification as read
exports.markNotificationAsRead = onCall(async (request) => {
  try {
    const { notificationId, userEmail } = request.data;

    if (!notificationId || !userEmail) {
      throw new Error("Notification ID and user email are required");
    }

    // Update notification status
    await admin.firestore().collection('notifications').doc(notificationId).update({
      is_read: true,
      read_at: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info("Notification marked as read", { 
      notificationId, 
      userEmail 
    });

    return {
      success: true,
      message: "Notification marked as read"
    };

  } catch (error) {
    logger.error("Error marking notification as read", { 
      error: error.message,
      notificationId: request.data?.notificationId,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to mark notification as read: ${error.message}`);
  }
});

// Mark all notifications as read
exports.markAllNotificationsAsRead = onCall(async (request) => {
  try {
    const { userEmail } = request.data;

    if (!userEmail) {
      throw new Error("User email is required");
    }

    // Get all unread notifications for the user
    const notificationsSnapshot = await admin.firestore()
      .collection('notifications')
      .where('user_email', '==', userEmail)
      .where('is_read', '==', false)
      .get();

    // Update all notifications to read
    const batch = admin.firestore().batch();
    notificationsSnapshot.forEach(doc => {
      const notificationRef = admin.firestore().collection('notifications').doc(doc.id);
      batch.update(notificationRef, {
        is_read: true,
        read_at: admin.firestore.FieldValue.serverTimestamp()
      });
    });
    await batch.commit();

    logger.info("All notifications marked as read", { 
      userEmail, 
      notificationCount: notificationsSnapshot.size 
    });

    return {
      success: true,
      message: "All notifications marked as read",
      notificationCount: notificationsSnapshot.size
    };

  } catch (error) {
    logger.error("Error marking all notifications as read", { 
      error: error.message,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to mark all notifications as read: ${error.message}`);
  }
});

// Delete notification
exports.deleteNotification = onCall(async (request) => {
  try {
    const { notificationId, userEmail } = request.data;

    if (!notificationId || !userEmail) {
      throw new Error("Notification ID and user email are required");
    }

    // Check if notification exists and belongs to user
    const notificationDoc = await admin.firestore().collection('notifications').doc(notificationId).get();
    
    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    const notification = notificationDoc.data();
    if (notification.user_email !== userEmail) {
      throw new Error("You can only delete your own notifications");
    }

    // Delete notification
    await admin.firestore().collection('notifications').doc(notificationId).delete();

    logger.info("Notification deleted successfully", { 
      notificationId, 
      userEmail 
    });

    return {
      success: true,
      notificationId: notificationId,
      message: "Notification deleted successfully"
    };

  } catch (error) {
    logger.error("Error deleting notification", { 
      error: error.message,
      notificationId: request.data?.notificationId,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to delete notification: ${error.message}`);
  }
});

// Generate S3 Presigned URL for Image Upload
exports.generateImageUploadUrl = onCall(async (request) => {
  try {
    const { fileName, fileType, programId } = request.data;

    // Validate input
    if (!fileName || !fileType) {
      throw new Error("Missing required fields: fileName and fileType are required");
    }

    // Validate file type (only images)
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(fileType.toLowerCase())) {
      throw new Error(`Invalid file type: ${fileType}. Only images are allowed (JPG, PNG, GIF, WEBP).`);
    }

    logger.info("Generating presigned URL for image upload", { fileName, fileType, programId });

    // Generate unique filename with timestamp to avoid collisions
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const folder = programId || 'temp';
    const key = `programs/${folder}/${timestamp}-${sanitizedFileName}`;
    
    const bucketName = "5032-a3-image-bucket";

    // Create S3 PutObject command
    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: fileType,
      // Add metadata
      Metadata: {
        uploadedBy: request.auth?.uid || "anonymous",
        uploadedAt: new Date().toISOString(),
        programId: programId || "none"
      }
    });

    // Generate presigned URL (expires in 5 minutes)
    const presignedUrl = await getSignedUrl(s3Client, command, { 
      expiresIn: 300 // 5 minutes
    });

    // Generate the public URL for accessing the image after upload
    const region = process.env.AWS_REGION || "ap-southeast-2";
    const publicUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

    logger.info("Presigned URL generated successfully", { 
      fileName, 
      key, 
      programId 
    });

    return {
      success: true,
      uploadUrl: presignedUrl,
      publicUrl: publicUrl,
      key: key,
      message: "Presigned URL generated successfully"
    };

  } catch (error) {
    logger.error("Error generating presigned URL", { 
      error: error.message,
      fileName: request.data?.fileName
    });
    
    throw new Error(`Failed to generate upload URL: ${error.message}`);
  }
});

/**
 * Email utility functions
 */
async function sendEmail(to, subject, htmlContent, textContent) {
  if (!process.env.AWS_SES_ROLE_ACCESS_KEY_ID || !process.env.AWS_SES_ROLE_ACCESS_KEY) {
    logger.warn('AWS SES credentials not configured, skipping email send');
    return { success: false, error: 'AWS SES not configured' };
  }

  try {
    const emailParams = {
      Source: fromEmail,
      Destination: {
        ToAddresses: [to]
      },
      Message: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8'
        },
        Body: {
          Html: {
            Data: htmlContent,
            Charset: 'UTF-8'
          },
          Text: {
            Data: textContent,
            Charset: 'UTF-8'
          }
        }
      }
    };

    const command = new SendEmailCommand(emailParams);
    const response = await sesClient.send(command);
    
    logger.info('Email sent successfully', { 
      to, 
      subject, 
      messageId: response.MessageId 
    });
    return { success: true, messageId: response.MessageId };
  } catch (error) {
    logger.error('Error sending email', { 
      error: error.message, 
      to, 
      subject,
      errorName: error.name 
    });
    
    // Check for specific AWS SES errors
    if (error.name === 'MessageRejected') {
      return { 
        success: false, 
        error: `Message rejected: ${error.message}. Please verify the sender email address in AWS SES.` 
      };
    }
    
    return { success: false, error: error.message };
  }
}

async function sendProgramCancellationEmail(memberEmail, programData) {
  const subject = `Program Cancelled: ${programData.title}`;
  
  // Format schedule information
  let scheduleInfo = '';
  if (programData.schedule && programData.schedule.length > 0) {
    scheduleInfo = programData.schedule.map(schedule => 
      `${schedule.day}s: ${schedule.start} - ${schedule.end}`
    ).join('<br>');
  } else {
    scheduleInfo = 'Schedule details not available';
  }
  
  // Format venue information
  const venueName = programData.venue?.name || 'Venue TBD';
  const venueAddress = programData.venue?.address || 'Address TBD';
  const venueSuburb = programData.venue?.suburb || '';
  const fullAddress = venueSuburb ? `${venueAddress}, ${venueSuburb}` : venueAddress;
  
  // Format cost information
  const costInfo = programData.cost === 0 ? 'Free' : `$${programData.cost} ${programData.costUnit || 'per session'}`;
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #dc3545; margin: 0;">Program Cancelled</h1>
        <p style="color: #666; margin: 10px 0 0 0;">Community Sport Platform</p>
      </div>
      
      <p>Dear Member,</p>
      <p>We regret to inform you that the following program has been cancelled:</p>
      
      <div style="background-color: #f8f9fa; padding: 25px; border-radius: 10px; margin: 25px 0; border-left: 4px solid #dc3545;">
        <h3 style="margin-top: 0; color: #333; font-size: 1.3em;">${programData.title}</h3>
        <div style="margin: 15px 0;">
          <p style="margin: 8px 0;"><strong>Sport:</strong> ${programData.sport}</p>
          <p style="margin: 8px 0;"><strong>Venue:</strong> ${venueName}</p>
          <p style="margin: 8px 0;"><strong>Address:</strong> ${fullAddress}</p>
          <p style="margin: 8px 0;"><strong>Cost:</strong> ${costInfo}</p>
          <p style="margin: 8px 0;"><strong>Max Participants:</strong> ${programData.maxParticipants || 'Not specified'}</p>
        </div>
        
        <div style="margin: 15px 0;">
          <p style="margin: 8px 0 5px 0;"><strong>Schedule:</strong></p>
          <div style="color: #666; font-size: 0.9em;">${scheduleInfo}</div>
        </div>
      </div>
      
      <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #ffc107;">
        <p style="margin: 0; color: #856404;"><strong>Important:</strong> Your appointment for this program has been automatically cancelled and removed from your account.</p>
      </div>
      
      <p>If you have any questions or would like to find alternative programs, please visit our website or contact us through our support page.</p>
      
      <p>We apologize for any inconvenience this may cause and thank you for your understanding.</p>
      
      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center;">
        <p style="color: #666; font-size: 0.9em; margin: 0;">Best regards,<br><strong>Community Sport Team</strong></p>
        <p style="color: #999; font-size: 0.8em; margin: 10px 0 0 0;">This is an automated message from Community Sport Platform</p>
      </div>
    </div>
  `;

  const textContent = `
Program Cancelled: ${programData.title}

Dear Member,

We regret to inform you that the following program has been cancelled:

Program: ${programData.title}
Sport: ${programData.sport}
Venue: ${venueName}
Address: ${fullAddress}
Cost: ${costInfo}
Max Participants: ${programData.maxParticipants || 'Not specified'}

Schedule:
${programData.schedule && programData.schedule.length > 0 
  ? programData.schedule.map(schedule => 
      `${schedule.day}s: ${schedule.start} - ${schedule.end}`
    ).join('\n')
  : 'Schedule details not available'
}

IMPORTANT: Your appointment for this program has been automatically cancelled and removed from your account.

If you have any questions or would like to find alternative programs, please visit our website or contact us through our support page.

We apologize for any inconvenience this may cause and thank you for your understanding.

Best regards,
Community Sport Team

---
This is an automated message from Community Sport Platform
  `;

  return await sendEmail(memberEmail, subject, htmlContent, textContent);
}

async function sendAppointmentCancellationEmail(organizerEmail, appointmentData, memberData) {
  const subject = `Appointment Cancelled: ${appointmentData.program_title}`;
  
  // Format appointment date safely
  let appointmentDateStr = 'Date not specified';
  try {
    if (appointmentData.appointment_date) {
      appointmentDateStr = new Date(appointmentData.appointment_date).toLocaleDateString();
    }
  } catch (error) {
    logger.warn('Error formatting appointment date', { error: error.message, appointment_date: appointmentData.appointment_date });
  }
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <div style="text-align: center; margin-bottom: 30px;">
        <h1 style="color: #ffc107; margin: 0;">Appointment Cancelled</h1>
        <p style="color: #666; margin: 10px 0 0 0;">Community Sport Platform</p>
      </div>
      
      <p>Dear Organizer,</p>
      <p>A member has cancelled their appointment for the following program:</p>
      
      <div style="background-color: #f8f9fa; padding: 25px; border-radius: 10px; margin: 25px 0; border-left: 4px solid #ffc107;">
        <h3 style="margin-top: 0; color: #333; font-size: 1.3em;">${appointmentData.program_title}</h3>
        <div style="margin: 15px 0;">
          <p style="margin: 8px 0;"><strong>Member Name:</strong> ${memberData.displayName || memberData.email}</p>
          <p style="margin: 8px 0;"><strong>Member Email:</strong> ${memberData.email}</p>
          <p style="margin: 8px 0;"><strong>Appointment Date:</strong> ${appointmentDateStr}</p>
          <p style="margin: 8px 0;"><strong>Appointment Time:</strong> ${appointmentData.appointment_time || 'Time not specified'}</p>
          <p style="margin: 8px 0;"><strong>Status:</strong> <span style="color: #dc3545; font-weight: bold;">Cancelled</span></p>
        </div>
      </div>
      
      <div style="background-color: #e7f3ff; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #007bff;">
        <p style="margin: 0; color: #004085;"><strong>Note:</strong> This appointment has been automatically removed from your program's participant list. You can view and manage your remaining program appointments in your organizer dashboard.</p>
      </div>
      
      <p>If you have any questions about this cancellation or need assistance with your program management, please contact us through our support page.</p>
      
      <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center;">
        <p style="color: #666; font-size: 0.9em; margin: 0;">Best regards,<br><strong>Community Sport Team</strong></p>
        <p style="color: #999; font-size: 0.8em; margin: 10px 0 0 0;">This is an automated message from Community Sport Platform</p>
      </div>
    </div>
  `;

  const textContent = `
Appointment Cancelled: ${appointmentData.program_title}

Dear Organizer,

A member has cancelled their appointment for the following program:

Program: ${appointmentData.program_title}
Member Name: ${memberData.displayName || memberData.email}
Member Email: ${memberData.email}
Appointment Date: ${appointmentDateStr}
Appointment Time: ${appointmentData.appointment_time || 'Time not specified'}
Status: Cancelled

NOTE: This appointment has been automatically removed from your program's participant list. You can view and manage your remaining program appointments in your organizer dashboard.

If you have any questions about this cancellation or need assistance with your program management, please contact us through our support page.

Best regards,
Community Sport Team

---
This is an automated message from Community Sport Platform
  `;

  return await sendEmail(organizerEmail, subject, htmlContent, textContent);
}

// Get user appointments
exports.getUserAppointments = onCall(async (request) => {
  try {
    const { user_email } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to view appointments");
    }

    if (!user_email) {
      throw new Error("User email is required");
    }

    logger.info("Getting user appointments", { user_email, userId });

    // Get Firestore instance
    const db = admin.firestore();

    // Query appointments for the user
    const appointmentsSnapshot = await admin.firestore()
      .collection('appointments')
      .where('member_email', '==', user_email)
      .get();

    const appointments = [];

    for (const doc of appointmentsSnapshot.docs) {
      const appointmentData = { id: doc.id, ...doc.data() };
      
      // Skip cancelled appointments
      if (appointmentData.status === "cancelled") {
        logger.info("Skipping cancelled appointment", { appointmentId: doc.id });
        continue;
      }
      
      // Get program details for each appointment
      try {
        if (appointmentData.program_id) {
          const programDoc = await db.collection("programs").doc(appointmentData.program_id).get();
          
          if (programDoc.exists) {
            const programData = programDoc.data();
            appointmentData.program = { id: programDoc.id, ...programData };
          } else {
            // Add placeholder program data
            appointmentData.program = {
              id: appointmentData.program_id,
              title: `Program ${appointmentData.program_id}`,
              sport: 'Unknown Sport'
            };
          }
        } else {
          appointmentData.program = {
            id: 'unknown',
            title: 'Unknown Program',
            sport: 'Unknown Sport'
          };
        }
      } catch (programError) {
        logger.error("Error fetching program details", { 
          programId: appointmentData.program_id, 
          error: programError.message
        });
        // Add placeholder program data on error
        appointmentData.program = {
          id: appointmentData.program_id || 'error',
          title: 'Error Loading Program',
          sport: 'Unknown Sport'
        };
      }
      
      appointments.push(appointmentData);
    }

    // Sort appointments by creation date (client-side since we removed orderBy)
    appointments.sort((a, b) => {
      const aTime = a.created_at?.toDate?.() || new Date(a.created_at || 0);
      const bTime = b.created_at?.toDate?.() || new Date(b.created_at || 0);
      return bTime - aTime;
    });

    logger.info("User appointments retrieved successfully", { count: appointments.length });

    return {
      success: true,
      appointments: appointments,
      count: appointments.length
    };

  } catch (error) {
    logger.error("Error getting user appointments", { 
      error: error.message, 
      user_email: request.data?.user_email
    });
    throw new Error(`Failed to get appointments: ${error.message}`);
  }
});

// Update an existing appointment
exports.updateAppointment = onCall(async (request) => {
  try {
    const { appointmentId, timeSlots, userEmail } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to update appointments");
    }

    if (!appointmentId || !timeSlots || !userEmail) {
      throw new Error("Appointment ID, time slots, and user email are required");
    }

    logger.info("Updating appointment", { appointmentId, userEmail });

    // Get Firestore instance
    const db = admin.firestore();

    // Get the existing appointment to verify ownership
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const appointmentDoc = await appointmentRef.get();

    if (!appointmentDoc.exists) {
      throw new Error("Appointment not found");
    }

    const existingAppointment = appointmentDoc.data();
    
    // Verify the user owns this appointment
    if (existingAppointment.member_email !== userEmail) {
      throw new Error("You can only update your own appointments");
    }

    // Update the appointment
    const updateData = {
      time_slot: timeSlots,
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    };

    await appointmentRef.update(updateData);

    logger.info("Appointment updated successfully", { appointmentId });

    return {
      success: true,
      appointmentId: appointmentId,
      message: "Appointment updated successfully"
    };

  } catch (error) {
    logger.error("Error updating appointment", { 
      error: error.message,
      appointmentId: request.data?.appointmentId
    });
    throw new Error(`Failed to update appointment: ${error.message}`);
  }
});

// Cancel an appointment
exports.cancelAppointment = onCall(async (request) => {
  try {
    const { appointmentId, userEmail } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to cancel appointments");
    }

    if (!appointmentId || !userEmail) {
      throw new Error("Appointment ID and user email are required");
    }

    logger.info("Canceling appointment", { appointmentId, userEmail });

    // Get Firestore instance
    const db = admin.firestore();

    // Get the appointment document
    const appointmentRef = db.collection("appointments").doc(appointmentId);
    const appointmentDoc = await appointmentRef.get();

    if (!appointmentDoc.exists) {
      throw new Error("Appointment not found");
    }

    const appointmentData = appointmentDoc.data();

    // Verify ownership - user can only cancel their own appointments
    if (appointmentData.member_email !== userEmail) {
      throw new Error("You can only cancel your own appointments");
    }

    // Check if appointment is already cancelled
    if (appointmentData.status === "cancelled") {
      throw new Error("Appointment is already cancelled");
    }

    // Get program details for notification
    const programRef = db.collection("programs").doc(appointmentData.program_id);
    const programDoc = await programRef.get();
    
    let programTitle = "Unknown Program";
    if (programDoc.exists) {
      const programData = programDoc.data();
      programTitle = programData.title || "Unknown Program";
    }

    // Create a batch for atomic operations
    const batch = db.batch();

    // Update appointment status to cancelled
    batch.update(appointmentRef, {
      status: "cancelled",
      cancelled_at: admin.firestore.FieldValue.serverTimestamp(),
      updated_at: admin.firestore.FieldValue.serverTimestamp()
    });

    // Create notification for the user
    const userNotificationRef = db.collection("notifications").doc();
    const userNotificationData = {
      notification_id: userNotificationRef.id,
      user_email: userEmail,
      notification_title: `Appointment cancelled: ${programTitle}`,
      notification_text: `You have successfully cancelled your appointment for: ${programTitle}. If you change your mind, you can book again from the program details page.`,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      read: false
    };
    
    batch.set(userNotificationRef, userNotificationData);
    
    // Create notification for the organizer
    if (programDoc.exists) {
      const programData = programDoc.data();
      const organizerEmail = programData.organizer_email;
      
      if (organizerEmail) {
        const organizerNotificationRef = db.collection("notifications").doc();
        const organizerNotificationData = {
          notification_id: organizerNotificationRef.id,
          user_email: organizerEmail,
          notification_title: `Appointment Cancelled: ${programTitle}`,
          notification_text: `A member has cancelled their appointment for your program "${programTitle}". The appointment has been automatically removed from your program's participant list.`,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
          read: false
        };
        
        batch.set(organizerNotificationRef, organizerNotificationData);
      }
    }

    // Execute all operations atomically
    await batch.commit();

    // Send email notification to organizer
    let organizerEmail = null;
    let memberData = null;
    
    if (programDoc.exists) {
      const programData = programDoc.data();
      organizerEmail = programData.organizer_email;
      
      // Get member data for the email
      try {
        const memberQuery = db.collection("user-information").where("email", "==", userEmail);
        const memberSnapshot = await memberQuery.get();
        if (!memberSnapshot.empty) {
          const memberDoc = memberSnapshot.docs[0];
          memberData = memberDoc.data();
        } else {
          // Fallback member data
          memberData = {
            email: userEmail,
            displayName: userEmail.split('@')[0] // Use email prefix as display name
          };
        }
      } catch (memberError) {
        logger.warn("Could not fetch member data", { error: memberError.message, userEmail });
        memberData = {
          email: userEmail,
          displayName: userEmail.split('@')[0]
        };
      }
    }

    // Send email to organizer if we have the necessary data
    if (organizerEmail && memberData) {
      const appointmentEmailData = {
        program_title: programTitle,
        appointment_date: appointmentData.appointment_date || new Date().toISOString().split('T')[0],
        appointment_time: appointmentData.time_slot || 'Unknown time'
      };

      sendAppointmentCancellationEmail(organizerEmail, appointmentEmailData, memberData)
        .then(result => {
          if (result.success) {
            logger.info("Organizer notification email sent", { 
              organizerEmail, 
              appointmentId, 
              programTitle 
            });
          } else {
            logger.warn("Failed to send organizer notification email", { 
              organizerEmail, 
              appointmentId, 
              error: result.error 
            });
          }
        })
        .catch(error => {
          logger.error("Error sending organizer notification email", { 
            error: error.message, 
            organizerEmail, 
            appointmentId 
          });
        });
    } else {
      logger.warn("Could not send organizer notification email", { 
        organizerEmail: !!organizerEmail, 
        memberData: !!memberData, 
        appointmentId 
      });
    }

    logger.info("Appointment cancelled successfully", { 
      appointmentId, 
      userEmail,
      programId: appointmentData.program_id,
      programTitle: programTitle
    });

    return {
      success: true,
      message: "Appointment cancelled successfully",
      appointmentId: appointmentId,
      notificationSent: true
    };

  } catch (error) {
    logger.error("Error cancelling appointment", { 
      error: error.message,
      appointmentId: request.data?.appointmentId,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to cancel appointment: ${error.message}`);
  }
});

// Get user notifications
exports.getUserNotifications = onCall(async (request) => {
  try {
    const { userEmail, page = 1, limit = 20 } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to view notifications");
    }

    if (!userEmail) {
      throw new Error("User email is required");
    }

    logger.info("Getting user notifications", { userEmail, page, limit });

    // Get Firestore instance
    const db = admin.firestore();

    // Query notifications for the user (without orderBy to avoid index requirement)
    const notificationsQuery = db.collection("notifications")
      .where("user_email", "==", userEmail);

    const querySnapshot = await notificationsQuery.get();
    
    // Sort notifications by createdAt client-side (newest first)
    const allNotifications = [];
    querySnapshot.docs.forEach(doc => {
      const data = doc.data();
      allNotifications.push({
        notification_id: doc.id,
        ...data,
        // Convert Firestore timestamp to sortable format
        createdAtTimestamp: data.created_at ? data.created_at.toMillis() : 0
      });
    });
    
    // Sort by createdAt descending (newest first)
    allNotifications.sort((a, b) => b.createdAtTimestamp - a.createdAtTimestamp);
    
    // Apply pagination client-side
    const offset = (page - 1) * limit;
    const notifications = allNotifications.slice(offset, offset + limit);
    const hasMore = allNotifications.length > offset + limit;

    logger.info("User notifications retrieved successfully", { 
      userEmail, 
      count: notifications.length,
      hasMore 
    });

    return {
      success: true,
      notifications: notifications,
      hasMore: hasMore,
      page: page,
      total: allNotifications.length
    };

  } catch (error) {
    logger.error("Error getting user notifications", { 
      error: error.message,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to get notifications: ${error.message}`);
  }
});

// Mark notification as read
exports.markNotificationAsRead = onCall(async (request) => {
  try {
    const { notificationId, userEmail } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to mark notifications as read");
    }

    if (!notificationId || !userEmail) {
      throw new Error("Notification ID and user email are required");
    }

    logger.info("Marking notification as read", { notificationId, userEmail });

    // Get Firestore instance
    const db = admin.firestore();

    // Get the notification document
    const notificationRef = db.collection("notifications").doc(notificationId);
    const notificationDoc = await notificationRef.get();

    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = notificationDoc.data();

    // Verify ownership - user can only mark their own notifications as read
    if (notificationData.user_email !== userEmail) {
      throw new Error("You can only mark your own notifications as read");
    }

    // Update notification as read
    await notificationRef.update({
      read: true,
      read_at: admin.firestore.FieldValue.serverTimestamp()
    });

    logger.info("Notification marked as read successfully", { notificationId, userEmail });

    return {
      success: true,
      notificationId: notificationId,
      message: "Notification marked as read"
    };

  } catch (error) {
    logger.error("Error marking notification as read", { 
      error: error.message,
      notificationId: request.data?.notificationId,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to mark notification as read: ${error.message}`);
  }
});

// Mark all notifications as read
exports.markAllNotificationsAsRead = onCall(async (request) => {
  try {
    const { userEmail } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to mark notifications as read");
    }

    if (!userEmail) {
      throw new Error("User email is required");
    }

    logger.info("Marking all notifications as read", { userEmail });

    // Get Firestore instance
    const db = admin.firestore();

    // Get all unread notifications for the user
    const notificationsQuery = db.collection("notifications")
      .where("user_email", "==", userEmail)
      .where("read", "==", false);

    const querySnapshot = await notificationsQuery.get();
    
    if (querySnapshot.empty) {
      return {
        success: true,
        message: "No unread notifications found",
        updatedCount: 0
      };
    }

    // Update all unread notifications in a batch
    const batch = db.batch();
    const timestamp = admin.firestore.FieldValue.serverTimestamp();

    querySnapshot.docs.forEach(doc => {
      batch.update(doc.ref, {
        read: true,
        read_at: timestamp
      });
    });

    await batch.commit();

    logger.info("All notifications marked as read successfully", { 
      userEmail, 
      updatedCount: querySnapshot.docs.length 
    });

    return {
      success: true,
      message: "All notifications marked as read",
      updatedCount: querySnapshot.docs.length
    };

  } catch (error) {
    logger.error("Error marking all notifications as read", { 
      error: error.message,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to mark all notifications as read: ${error.message}`);
  }
});

// Delete notification
exports.deleteNotification = onCall(async (request) => {
  try {
    const { notificationId, userEmail } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to delete notifications");
    }

    if (!notificationId || !userEmail) {
      throw new Error("Notification ID and user email are required");
    }

    logger.info("Deleting notification", { notificationId, userEmail });

    // Get Firestore instance
    const db = admin.firestore();

    // Get the notification document
    const notificationRef = db.collection("notifications").doc(notificationId);
    const notificationDoc = await notificationRef.get();

    if (!notificationDoc.exists) {
      throw new Error("Notification not found");
    }

    const notificationData = notificationDoc.data();

    // Verify ownership - user can only delete their own notifications
    if (notificationData.user_email !== userEmail) {
      throw new Error("You can only delete your own notifications");
    }

    // Delete the notification
    await notificationRef.delete();

    logger.info("Notification deleted successfully", { notificationId, userEmail });

    return {
      success: true,
      notificationId: notificationId,
      message: "Notification deleted successfully"
    };

  } catch (error) {
    logger.error("Error deleting notification", { 
      error: error.message,
      notificationId: request.data?.notificationId,
      userEmail: request.data?.userEmail
    });
    
    throw new Error(`Failed to delete notification: ${error.message}`);
  }
});


// Generate Organizer PDF Report
exports.generateOrganizerReport = onCall(async (request) => {
  try {
    const { organizerEmail, includeCancelled = false } = request.data;
    const userId = request.auth?.uid;

    if (!userId) {
      throw new Error("User must be authenticated to generate reports");
    }

    if (!organizerEmail) {
      throw new Error("Organizer email is required");
    }

    logger.info("Generating organizer report", { organizerEmail, includeCancelled });

    // Get Firestore instance
    const db = admin.firestore();

    // Get organizer's programs
    let programsQuery = db.collection("programs")
      .where("organizer_email", "==", organizerEmail);
    
    if (!includeCancelled) {
      programsQuery = programsQuery.where("status", "==", "active");
    }

    const programsSnapshot = await programsQuery.get();
    const programs = [];
    
    for (const doc of programsSnapshot.docs) {
      const programData = { id: doc.id, ...doc.data() };
      
      // Get appointments for this program
      const appointmentsSnapshot = await db.collection("appointments")
        .where("program_id", "==", doc.id)
        .where("status", "==", "confirmed")
        .get();
      
      const appointments = [];
      appointmentsSnapshot.forEach(appointmentDoc => {
        appointments.push({
          id: appointmentDoc.id,
          ...appointmentDoc.data()
        });
      });
      
      programData.appointments = appointments;
      programs.push(programData);
    }

    // Calculate statistics
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();
    const firstDayOfMonth = new Date(currentYear, currentMonth, 1);

    // Overall statistics
    const totalPrograms = programs.length;
    const totalAppointments = programs.reduce((sum, program) => sum + program.appointments.length, 0);
    
    // Monthly statistics
    const monthlyStats = programs.map(program => {
      const monthlyAppointments = program.appointments.filter(apt => {
        const aptDate = apt.created_at?.toDate?.() || new Date(apt.created_at || 0);
        return aptDate >= firstDayOfMonth;
      });
      
      return {
        programId: program.id,
        programTitle: program.title,
        totalAppointments: program.appointments.length,
        monthlyAppointments: monthlyAppointments.length,
        monthlyGrowth: monthlyAppointments.length
      };
    });

    // Generate a properly formatted PDF using a better approach
    const reportContent = generateFormattedReport(organizerEmail, programs, monthlyStats, {
      totalPrograms,
      totalAppointments,
      reportDate: currentDate.toLocaleDateString(),
      includeCancelled
    });

    // Create a proper PDF with correct formatting
    const pdfContent = createFormattedPDF(reportContent);
    const pdfBuffer = Buffer.from(pdfContent, 'utf8');

    // Upload PDF report to S3
    const timestamp = Date.now();
    const fileName = `organizer-report-${organizerEmail.replace('@', '-')}-${timestamp}.pdf`;
    const key = `reports/${fileName}`;
    const bucketName = "5032-a3-image-bucket";

    const uploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: pdfBuffer,
      ContentType: 'application/pdf',
      ContentDisposition: `attachment; filename="${fileName}"`,
      Metadata: {
        organizerEmail: organizerEmail,
        generatedAt: new Date().toISOString(),
        reportType: 'organizer-report'
      }
    });

    await s3Client.send(uploadCommand);

    // Generate public URL
    const region = process.env.AWS_REGION || "ap-southeast-2";
    const pdfUrl = `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;

    logger.info("Organizer report generated successfully", { 
      organizerEmail, 
      pdfUrl,
      totalPrograms,
      totalAppointments
    });

    return {
      success: true,
      pdfUrl: pdfUrl,
      message: "PDF report generated successfully",
      stats: {
        totalPrograms,
        totalAppointments,
        reportDate: currentDate.toISOString()
      }
    };

  } catch (error) {
    logger.error("Error generating organizer report", { 
      error: error.message,
      organizerEmail: request.data?.organizerEmail
    });
    
    throw new Error(`Failed to generate report: ${error.message}`);
  }
});

// Helper function to generate formatted report content
function generateFormattedReport(organizerEmail, programs, monthlyStats, overallStats) {
  const { totalPrograms, totalAppointments, reportDate, includeCancelled } = overallStats;
  
  let report = [];
  
  // Header
  report.push({
    type: 'header',
    content: 'ORGANIZER REPORT',
    style: 'title'
  });
  report.push({
    type: 'text',
    content: `Generated for: ${organizerEmail}`,
    style: 'subtitle'
  });
  report.push({
    type: 'text',
    content: `Report Date: ${reportDate}`,
    style: 'subtitle'
  });
  
  // Statistics
  report.push({
    type: 'section',
    content: 'OVERALL STATISTICS',
    style: 'sectionHeader'
  });
  report.push({
    type: 'text',
    content: `Total Programs: ${totalPrograms}`,
    style: 'normal'
  });
  report.push({
    type: 'text',
    content: `Total Appointments: ${totalAppointments}`,
    style: 'normal'
  });
  report.push({
    type: 'text',
    content: `This Month's Appointments: ${monthlyStats.reduce((sum, stat) => sum + stat.monthlyAppointments, 0)}`,
    style: 'normal'
  });
  
  // Programs
  programs.forEach((program, index) => {
    report.push({
      type: 'section',
      content: `PROGRAM ${index + 1}: ${program.title}`,
      style: 'programHeader'
    });
    report.push({
      type: 'text',
      content: `Status: ${program.status.toUpperCase()}`,
      style: 'status',
      color: program.status === 'active' ? 'green' : 'red'
    });
    report.push({
      type: 'text',
      content: `Sport: ${program.sport || 'Not specified'}`,
      style: 'normal'
    });
    report.push({
      type: 'text',
      content: `Venue: ${program.venue?.name || 'TBD'}`,
      style: 'normal'
    });
    report.push({
      type: 'text',
      content: `Address: ${program.venue?.address || 'TBD'}`,
      style: 'normal'
    });
    report.push({
      type: 'text',
      content: `Cost: ${program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit || 'per session'}`}`,
      style: 'normal'
    });
    report.push({
      type: 'text',
      content: `Max Participants: ${program.maxParticipants || 'Not specified'}`,
      style: 'normal'
    });
    report.push({
      type: 'text',
      content: `Description: ${program.description || 'No description provided'}`,
      style: 'normal'
    });
    
    if (program.schedule && program.schedule.length > 0) {
      report.push({
        type: 'text',
        content: 'Schedule:',
        style: 'label'
      });
      program.schedule.forEach(schedule => {
        report.push({
          type: 'text',
          content: `  ${schedule.day}s: ${schedule.start} - ${schedule.end}`,
          style: 'indent'
        });
      });
    }
    
    report.push({
      type: 'text',
      content: `Appointments (${program.appointments.length}):`,
      style: 'label'
    });
    
    if (program.appointments.length > 0) {
      report.push({
        type: 'table',
        headers: ['Name', 'Email', 'Date', 'Time'],
        rows: program.appointments.map(apt => [
          apt.member_name || 'Unknown',
          apt.member_email || 'N/A',
          apt.appointment_date || 'N/A',
          apt.appointment_time || 'N/A'
        ])
      });
    } else {
      report.push({
        type: 'text',
        content: 'No appointments found for this program.',
        style: 'italic'
      });
    }
    
    // Monthly stats for this program
    const programStats = monthlyStats.find(stat => stat.programId === program.id);
    if (programStats) {
      report.push({
        type: 'text',
        content: 'This Month\'s Statistics:',
        style: 'label'
      });
      report.push({
        type: 'text',
        content: `  New Appointments: ${programStats.monthlyAppointments}`,
        style: 'indent'
      });
      report.push({
        type: 'text',
        content: `  Total Appointments: ${programStats.totalAppointments}`,
        style: 'indent'
      });
    }
  });
  
  // Footer
  report.push({
    type: 'text',
    content: 'This report was generated automatically by the Community Sport Platform',
    style: 'footer'
  });
  report.push({
    type: 'text',
    content: 'For support, please contact us through the platform',
    style: 'footer'
  });
  
  return report;
}

// Function to send program cancellation email with PDF attachment
async function sendProgramCancellationEmail(memberEmail, program, organizerEmail) {
  try {
    console.log(`Sending program cancellation email to: ${memberEmail}`);
    
    // Generate PDF attachment
    const pdfContent = createCancellationPDF(program, organizerEmail);
    const pdfBuffer = Buffer.from(pdfContent, 'utf8');
    const pdfBase64 = pdfBuffer.toString('base64');
    
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Program Cancellation Notice</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 20px auto; background-color: white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: linear-gradient(135deg, #dc3545, #c82333); color: white; padding: 30px 20px; text-align: center; }
          .header h1 { margin: 0; font-size: 24px; font-weight: 600; }
          .content { padding: 30px; }
          .program-details { background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 6px; border-left: 4px solid #dc3545; }
          .program-details h3 { margin-top: 0; color: #dc3545; font-size: 18px; }
          .detail-row { margin: 8px 0; }
          .detail-label { font-weight: 600; color: #495057; }
          .schedule-list { margin: 10px 0; padding-left: 20px; }
          .schedule-list li { margin: 5px 0; }
          .footer { text-align: center; margin-top: 30px; padding: 20px; background-color: #f8f9fa; border-top: 1px solid #dee2e6; font-size: 12px; color: #6c757d; }
          .highlight { color: #dc3545; font-weight: bold; }
          .important-notice { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 6px; margin: 20px 0; }
          .important-notice strong { color: #856404; }
          .contact-info { background-color: #e3f2fd; padding: 15px; border-radius: 6px; margin: 20px 0; }
          .contact-info strong { color: #1976d2; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🚫 Program Cancellation Notice</h1>
          </div>
          <div class="content">
            <p>Dear Valued Member,</p>
            <p>We regret to inform you that the following program has been <span class="highlight">cancelled</span> by the organizer:</p>
            
            <div class="program-details">
              <h3>📋 Program Details</h3>
              <div class="detail-row"><span class="detail-label">Program Name:</span> ${program.title || 'Not specified'}</div>
              <div class="detail-row"><span class="detail-label">Sport:</span> ${program.sport || 'Not specified'}</div>
              <div class="detail-row"><span class="detail-label">Venue:</span> ${program.venue?.name || 'TBD'}</div>
              <div class="detail-row"><span class="detail-label">Address:</span> ${program.venue?.address || 'TBD'}</div>
              <div class="detail-row"><span class="detail-label">Cost:</span> ${program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit || 'per session'}`}</div>
              <div class="detail-row"><span class="detail-label">Max Participants:</span> ${program.maxParticipants || 'Not specified'}</div>
              ${program.schedule && program.schedule.length > 0 ? `
                <div class="detail-row"><span class="detail-label">Schedule:</span></div>
                <ul class="schedule-list">
                  ${program.schedule.map(schedule => `<li>${schedule.day}s: ${schedule.start} - ${schedule.end}</li>`).join('')}
                </ul>
              ` : ''}
              ${program.description ? `<div class="detail-row"><span class="detail-label">Description:</span> ${program.description}</div>` : ''}
            </div>
            
            <div class="important-notice">
              <strong>⚠️ Important Notice:</strong> Your appointment for this program has been automatically cancelled and removed from your account. No further action is required on your part.
            </div>
            
            <div class="contact-info">
              <strong>📞 Need Help?</strong> If you have any questions or concerns about this cancellation, please contact the program organizer directly or reach out to our support team through the Community Sport Platform.
            </div>
            
            <p>We sincerely apologize for any inconvenience this cancellation may cause. We appreciate your understanding and continued participation in our community sports programs.</p>
            
            <p>Thank you for being a valued member of our community.</p>
            
            <p>Best regards,<br>
            <strong>Community Sport Platform Team</strong><br>
            <em>Connecting communities through sports</em></p>
          </div>
          <div class="footer">
            <p>This email was sent automatically by the Community Sport Platform</p>
            <p>For technical support, please contact us through the platform or visit our help center</p>
            <p>&copy; 2025 Community Sport Platform. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
      ===============================================
      PROGRAM CANCELLATION NOTICE
      ===============================================
      
      Dear Valued Member,
      
      We regret to inform you that the following program has been CANCELLED by the organizer:
      
      PROGRAM DETAILS:
      ================
      Program Name: ${program.title || 'Not specified'}
      Sport: ${program.sport || 'Not specified'}
      Venue: ${program.venue?.name || 'TBD'}
      Address: ${program.venue?.address || 'TBD'}
      Cost: ${program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit || 'per session'}`}
      Max Participants: ${program.maxParticipants || 'Not specified'}
      ${program.schedule && program.schedule.length > 0 ? `
      Schedule:
      ${program.schedule.map(schedule => `  - ${schedule.day}s: ${schedule.start} - ${schedule.end}`).join('\n')}
      ` : ''}
      ${program.description ? `Description: ${program.description}` : ''}
      
      IMPORTANT NOTICE:
      ================
      Your appointment for this program has been automatically cancelled and removed from your account. No further action is required on your part.
      
      NEED HELP?
      ==========
      If you have any questions or concerns about this cancellation, please contact the program organizer directly or reach out to our support team through the Community Sport Platform.
      
      We sincerely apologize for any inconvenience this cancellation may cause. We appreciate your understanding and continued participation in our community sports programs.
      
      Thank you for being a valued member of our community.
      
      Best regards,
      Community Sport Platform Team
      Connecting communities through sports
      
      ===============================================
      This email was sent automatically by the Community Sport Platform
      For technical support, please contact us through the platform
      © 2025 Community Sport Platform. All rights reserved.
      ===============================================
    `;

    // Create multipart email with PDF attachment
    const boundary = '----=_Part_' + Math.random().toString(36).substr(2, 9);
    const fromEmail = process.env.AWS_SES_FROM_ADDRESS || 'qq1097215944@gmail.com';
    
    const rawEmail = [
      `From: ${fromEmail}`,
      `To: ${memberEmail}`,
      `Subject: Program Cancellation: ${program.title || 'Program'}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      htmlContent,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="cancellation-notice.pdf"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="cancellation-notice.pdf"`,
      ``,
      pdfBase64,
      ``,
      `--${boundary}--`
    ].join('\r\n');

    const emailParams = {
      RawMessage: {
        Data: Buffer.from(rawEmail)
      }
    };

    const command = new SendRawEmailCommand(emailParams);
    const result = await sesClient.send(command);
    
    console.log(`Program cancellation email with PDF attachment sent successfully to ${memberEmail}:`, result.MessageId);
    return { success: true, messageId: result.MessageId };
    
  } catch (error) {
    console.error(`Error sending program cancellation email to ${memberEmail}:`, error);
    throw error;
  }
}

// Function to send appointment cancellation email with PDF attachment
async function sendAppointmentCancellationEmail(organizerEmail, appointment, program) {
  try {
    console.log(`Sending appointment cancellation email to organizer: ${organizerEmail}`);
    
    // Generate PDF attachment for appointment cancellation
    const pdfContent = createAppointmentCancellationPDF(appointment, program, organizerEmail);
    const pdfBuffer = Buffer.from(pdfContent, 'utf8');
    const pdfBase64 = pdfBuffer.toString('base64');
    
    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Appointment Cancellation Notice</title>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #ffc107; color: #333; padding: 20px; text-align: center; border-radius: 5px 5px 0 0; }
          .content { background-color: #f8f9fa; padding: 20px; border-radius: 0 0 5px 5px; }
          .appointment-details { background-color: white; padding: 15px; margin: 15px 0; border-radius: 5px; border-left: 4px solid #ffc107; }
          .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #666; }
          .highlight { color: #ffc107; font-weight: bold; }
          .attachment-notice { background-color: #fff3cd; padding: 10px; border-radius: 5px; margin: 15px 0; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Appointment Cancellation Notice</h1>
          </div>
          <div class="content">
            <p>Dear Organizer,</p>
            <p>A member has <span class="highlight">cancelled</span> their appointment for the following program:</p>
            
            <div class="appointment-details">
              <h3>${program.title || 'Program Title'}</h3>
              <p><strong>Member Name:</strong> ${appointment.member_name || 'Unknown'}</p>
              <p><strong>Member Email:</strong> ${appointment.member_email || 'N/A'}</p>
              <p><strong>Appointment Date:</strong> ${appointment.appointment_date || 'N/A'}</p>
              <p><strong>Appointment Time:</strong> ${appointment.appointment_time || 'N/A'}</p>
              <p><strong>Sport:</strong> ${program.sport || 'Not specified'}</p>
              <p><strong>Venue:</strong> ${program.venue?.name || 'TBD'}</p>
              <p><strong>Address:</strong> ${program.venue?.address || 'TBD'}</p>
            </div>
            
            <div class="attachment-notice">
              <p><strong>📎 Attachment:</strong> A detailed cancellation notice PDF has been attached to this email for your records.</p>
            </div>
            
            <p><strong>Note:</strong> This appointment has been automatically removed from your program's participant list.</p>
            
            <p>Best regards,<br>
            Community Sport Platform Team</p>
          </div>
          <div class="footer">
            <p>This email was sent automatically by the Community Sport Platform</p>
            <p>For support, please contact us through the platform</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
      APPOINTMENT CANCELLATION NOTICE
      
      Dear Organizer,
      
      A member has CANCELLED their appointment for the following program:
      
      Program: ${program.title || 'Program Title'}
      Member Name: ${appointment.member_name || 'Unknown'}
      Member Email: ${appointment.member_email || 'N/A'}
      Appointment Date: ${appointment.appointment_date || 'N/A'}
      Appointment Time: ${appointment.appointment_time || 'N/A'}
      Sport: ${program.sport || 'Not specified'}
      Venue: ${program.venue?.name || 'TBD'}
      Address: ${program.venue?.address || 'TBD'}
      
      ATTACHMENT: A detailed cancellation notice PDF has been attached to this email for your records.
      
      NOTE: This appointment has been automatically removed from your program's participant list.
      
      Best regards,
      Community Sport Platform Team
      
      ---
      This email was sent automatically by the Community Sport Platform
      For support, please contact us through the platform
    `;

    // Create multipart email with PDF attachment
    const boundary = '----=_Part_' + Math.random().toString(36).substr(2, 9);
    const fromEmail = process.env.AWS_SES_FROM_ADDRESS || 'qq1097215944@gmail.com';
    
    const rawEmail = [
      `From: ${fromEmail}`,
      `To: ${organizerEmail}`,
      `Subject: Appointment Cancelled: ${program.title || 'Program'}`,
      `MIME-Version: 1.0`,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      `--${boundary}`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 7bit`,
      ``,
      htmlContent,
      ``,
      `--${boundary}`,
      `Content-Type: application/pdf; name="appointment-cancellation-notice.pdf"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="appointment-cancellation-notice.pdf"`,
      ``,
      pdfBase64,
      ``,
      `--${boundary}--`
    ].join('\r\n');

    const emailParams = {
      RawMessage: {
        Data: Buffer.from(rawEmail)
      }
    };

    const command = new SendRawEmailCommand(emailParams);
    const result = await sesClient.send(command);
    
    console.log(`Appointment cancellation email with PDF attachment sent successfully to ${organizerEmail}:`, result.MessageId);
    return { success: true, messageId: result.MessageId };
    
  } catch (error) {
    console.error(`Error sending appointment cancellation email to ${organizerEmail}:`, error);
    throw error;
  }
}

// Helper function to create a PDF for appointment cancellation details
function createAppointmentCancellationPDF(appointment, program, organizerEmail) {
  // Generate the content stream
  let contentStream = `BT
/F1 24 Tf
72 720 Td
(APPOINTMENT CANCELLATION NOTICE) Tj
0 -30 Td
/F2 12 Tf
`;

  let yPosition = 690;
  const leftMargin = 72;

  // Header information
  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Program: ${program.title}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Organizer: ${organizerEmail}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Cancellation Date: ${new Date().toLocaleDateString()}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 30;

  // Member details section
  contentStream += `ET
BT
/F1 16 Tf
${leftMargin} ${yPosition} Td
(MEMBER DETAILS) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 25;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Name: ${appointment.member_name || 'Unknown'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Email: ${appointment.member_email || 'N/A'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Appointment Date: ${appointment.appointment_date || 'N/A'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Appointment Time: ${appointment.appointment_time || 'N/A'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 30;

  // Program details section
  contentStream += `ET
BT
/F1 16 Tf
${leftMargin} ${yPosition} Td
(PROGRAM DETAILS) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 25;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Sport: ${program.sport || 'Not specified'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Venue: ${program.venue?.name || 'TBD'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Address: ${program.venue?.address || 'TBD'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  // Important notice
  contentStream += `ET
BT
/F1 14 Tf
${leftMargin} ${yPosition} Td
(IMPORTANT NOTICE) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 10 Tf
${leftMargin} ${yPosition} Td
(This appointment has been automatically removed from your program's participant list.) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 10 Tf
${leftMargin} ${yPosition} Td
(You can contact the member directly if you have any questions.) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  // Footer
  contentStream += `ET
BT
/F3 10 Tf
${leftMargin} ${yPosition} Td
(This notice was generated automatically by the Community Sport Platform) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F3 10 Tf
${leftMargin} ${yPosition} Td
(For support, please contact us through the platform) Tj
ET
BT
/F2 12 Tf
`;

  contentStream += `ET`;

  const contentLength = contentStream.length;
  
  let pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
/Resources <<
/Font <<
/F1 5 0 R
/F2 6 0 R
/F3 7 0 R
>>
>>
>>
endobj

4 0 obj
<<
/Length ${contentLength}
>>
stream
${contentStream}
endstream
endobj

5 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Bold
>>
endobj

6 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica
>>
endobj

7 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Oblique
>>
endobj

xref
0 8
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000274 00000 n 
0000000${(contentLength + 100).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 200).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 300).toString().padStart(3, '0')} 00000 n 
trailer
<<
/Size 8
/Root 1 0 R
>>
startxref
${contentLength + 400}
%%EOF`;

  return pdfContent;
}

// Helper function to create a PDF for program cancellation details
function createCancellationPDF(program, organizerEmail, cancellationReason = 'Program has been cancelled by the organizer') {
  // Generate the content stream
  let contentStream = `BT
/F1 24 Tf
72 720 Td
(PROGRAM CANCELLATION NOTICE) Tj
0 -30 Td
/F2 12 Tf
`;

  let yPosition = 690;
  const leftMargin = 72;

  // Header information
  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Program: ${program.title}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Organizer: ${organizerEmail}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Cancellation Date: ${new Date().toLocaleDateString()}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 30;

  // Program details section
  contentStream += `ET
BT
/F1 16 Tf
${leftMargin} ${yPosition} Td
(PROGRAM DETAILS) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 25;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Sport: ${program.sport || 'Not specified'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Venue: ${program.venue?.name || 'TBD'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Address: ${program.venue?.address || 'TBD'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Cost: ${program.cost === 0 ? 'Free' : `$${program.cost} ${program.costUnit || 'per session'}`}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(Max Participants: ${program.maxParticipants || 'Not specified'}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  // Schedule section
  if (program.schedule && program.schedule.length > 0) {
    contentStream += `ET
BT
/F1 14 Tf
${leftMargin} ${yPosition} Td
(SCHEDULE) Tj
ET
BT
/F2 12 Tf
`;
    yPosition -= 20;

    program.schedule.forEach(schedule => {
      contentStream += `ET
BT
/F2 10 Tf
${leftMargin + 20} ${yPosition} Td
(${schedule.day}s: ${schedule.start} - ${schedule.end}) Tj
ET
BT
/F2 12 Tf
`;
      yPosition -= 12;
    });
    yPosition -= 10;
  }

  // Cancellation reason
  contentStream += `ET
BT
/F1 16 Tf
${leftMargin} ${yPosition} Td
(CANCELLATION REASON) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 25;

  contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(${cancellationReason}) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 30;

  // Important notice
  contentStream += `ET
BT
/F1 14 Tf
${leftMargin} ${yPosition} Td
(IMPORTANT NOTICE) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  contentStream += `ET
BT
/F2 10 Tf
${leftMargin} ${yPosition} Td
(Your appointment for this program has been automatically cancelled.) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F2 10 Tf
${leftMargin} ${yPosition} Td
(If you have any questions, please contact the organizer directly.) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 20;

  // Footer
  contentStream += `ET
BT
/F3 10 Tf
${leftMargin} ${yPosition} Td
(This notice was generated automatically by the Community Sport Platform) Tj
ET
BT
/F2 12 Tf
`;
  yPosition -= 15;

  contentStream += `ET
BT
/F3 10 Tf
${leftMargin} ${yPosition} Td
(For support, please contact us through the platform) Tj
ET
BT
/F2 12 Tf
`;

  contentStream += `ET`;

  const contentLength = contentStream.length;
  
  let pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
/Resources <<
/Font <<
/F1 5 0 R
/F2 6 0 R
/F3 7 0 R
>>
>>
>>
endobj

4 0 obj
<<
/Length ${contentLength}
>>
stream
${contentStream}
endstream
endobj

5 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Bold
>>
endobj

6 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica
>>
endobj

7 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Oblique
>>
endobj

xref
0 8
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000274 00000 n 
0000000${(contentLength + 100).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 200).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 300).toString().padStart(3, '0')} 00000 n 
trailer
<<
/Size 8
/Root 1 0 R
>>
startxref
${contentLength + 400}
%%EOF`;

  return pdfContent;
}

// Helper function to create a properly formatted PDF
function createFormattedPDF(reportData) {
  // Generate the content stream
  let contentStream = `BT
/F1 24 Tf
72 720 Td
(ORGANIZER REPORT) Tj
0 -30 Td
/F2 12 Tf
`;

  let yPosition = 690;
  const leftMargin = 72;

  // Process each report item
  reportData.forEach(item => {
    switch (item.type) {
      case 'header':
        contentStream += `ET
BT
/F1 18 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
        yPosition -= 30;
        break;
        
      case 'text':
        if (item.style === 'title') {
          contentStream += `ET
BT
/F1 24 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 40;
        } else if (item.style === 'subtitle') {
          contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 20;
        } else if (item.style === 'sectionHeader') {
          contentStream += `ET
BT
/F1 16 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 25;
        } else if (item.style === 'programHeader') {
          contentStream += `ET
BT
/F1 14 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 20;
        } else if (item.style === 'label') {
          contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 15;
        } else if (item.style === 'indent') {
          contentStream += `ET
BT
/F2 10 Tf
${leftMargin + 20} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 12;
        } else if (item.style === 'footer') {
          contentStream += `ET
BT
/F3 10 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 15;
        } else {
          // Normal text
          contentStream += `ET
BT
/F2 12 Tf
${leftMargin} ${yPosition} Td
(${item.content}) Tj
ET
BT
/F2 12 Tf
`;
          yPosition -= 15;
        }
        break;
        
      case 'table':
        if (item.headers && item.rows) {
          // Table headers
          contentStream += `ET
BT
/F2 10 Tf
${leftMargin} ${yPosition} Td
(${item.headers.join(' | ')}) Tj
ET
BT
/F2 10 Tf
`;
          yPosition -= 15;
          
          // Table rows
          item.rows.forEach(row => {
            contentStream += `ET
BT
/F2 9 Tf
${leftMargin} ${yPosition} Td
(${row.join(' | ')}) Tj
ET
BT
/F2 10 Tf
`;
            yPosition -= 12;
          });
        }
        break;
    }
  });

  contentStream += `ET`;

  const contentLength = contentStream.length;
  
  let pdfContent = `%PDF-1.4
1 0 obj
<<
/Type /Catalog
/Pages 2 0 R
>>
endobj

2 0 obj
<<
/Type /Pages
/Kids [3 0 R]
/Count 1
>>
endobj

3 0 obj
<<
/Type /Page
/Parent 2 0 R
/MediaBox [0 0 612 792]
/Contents 4 0 R
/Resources <<
/Font <<
/F1 5 0 R
/F2 6 0 R
/F3 7 0 R
>>
>>
>>
endobj

4 0 obj
<<
/Length ${contentLength}
>>
stream
${contentStream}
endstream
endobj

5 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Bold
>>
endobj

6 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica
>>
endobj

7 0 obj
<<
/Type /Font
/Subtype /Type1
/BaseFont /Helvetica-Oblique
>>
endobj

xref
0 8
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000274 00000 n 
0000000${(contentLength + 100).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 200).toString().padStart(3, '0')} 00000 n 
0000000${(contentLength + 300).toString().padStart(3, '0')} 00000 n 
trailer
<<
/Size 8
/Root 1 0 R
>>
startxref
${contentLength + 400}
%%EOF`;

  return pdfContent;
}